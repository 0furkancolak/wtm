import { lstat, readdir } from 'node:fs/promises';
import {
  listGitWorktrees as defaultListGitWorktrees,
  retriedWorktreeListTimeoutMs,
  type DaemonStateStore,
  type GitWorktreeRecord,
  type ReconcileResult,
  type RepositoryRecord,
  type WorkspaceRecord,
} from '@wtm/core';
import { UnsupportedPlatformError, supportedPlatforms } from '@wtm/platform';
import type { IpcRequest, JsonEnvelope } from '@wtm/protocol';
import { ReconcilerQueue, type ReconcileBatch, type ReconcileSignal } from './reconciler-queue';
import { UnixIpcServer, type IpcRequestHandler } from './server';
import { runtimeCommandNames } from './runtime-controller';
import {
  StructuralWatcher,
  type StructuralWatcherOptions,
  type WorkspaceWatchRegistration,
} from './watcher';

export interface DaemonRegistrationSnapshot {
  workspaces: readonly WorkspaceRecord[];
  repositories: readonly RepositoryRecord[];
}

export interface DaemonRecoveryHooks {
  verifyProcessIdentities(snapshot: DaemonRegistrationSnapshot): Promise<void> | void;
  verifyEndpointLeases(snapshot: DaemonRegistrationSnapshot): Promise<void> | void;
  scheduleCleanupRetries(snapshot: DaemonRegistrationSnapshot): Promise<void> | void;
}

export interface DaemonWatcherLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
  whenIdle(): Promise<void>;
}

export interface DaemonServerLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface DaemonProcessSupervisorLifecycle {
  recover(): Promise<unknown>;
  close(): Promise<void>;
}

export interface ReconciledRepository {
  repository: RepositoryRecord;
  result: ReconcileResult;
}

export interface WtmDaemonOptions {
  stateStore: DaemonStateStore;
  socketPath: string;
  recoveryHooks?: Partial<DaemonRecoveryHooks>;
  adapterDiscovery?: (snapshot: DaemonRegistrationSnapshot) => Promise<void> | void;
  onReconciled?: (reconciliation: ReconciledRepository) => Promise<void> | void;
  onError?: (error: unknown) => void;
  listGitWorktrees?: (repositoryRoot: string, timeoutMs?: number) => Promise<GitWorktreeRecord[]>;
  watcherFactory?: (
    registrations: readonly WorkspaceWatchRegistration[],
    schedule: (signal: ReconcileSignal) => void,
  ) => DaemonWatcherLifecycle;
  serverFactory?: (options: {
    socketPath: string;
    handler: IpcRequestHandler;
  }) => DaemonServerLifecycle;
  runtimeHandler?: IpcRequestHandler;
  processSupervisor?: DaemonProcessSupervisorLifecycle;
  watchFactory?: StructuralWatcherOptions['watchFactory'];
  fingerprint?: StructuralWatcherOptions['fingerprint'];
  platform?: NodeJS.Platform;
  nodeVersion?: string;
}

const noRecoveryWork = async () => {};

export class WtmDaemon {
  readonly #stateStore: DaemonStateStore;
  readonly #socketPath: string;
  readonly #recoveryHooks: DaemonRecoveryHooks;
  readonly #adapterDiscovery: NonNullable<WtmDaemonOptions['adapterDiscovery']>;
  readonly #onReconciled: NonNullable<WtmDaemonOptions['onReconciled']>;
  readonly #onError: (error: unknown) => void;
  readonly #listGitWorktrees: NonNullable<WtmDaemonOptions['listGitWorktrees']>;
  readonly #watcherFactory: NonNullable<WtmDaemonOptions['watcherFactory']>;
  readonly #serverFactory: NonNullable<WtmDaemonOptions['serverFactory']>;
  readonly #runtimeHandler: IpcRequestHandler | null;
  readonly #processSupervisor: DaemonProcessSupervisorLifecycle | null;
  readonly #queue: ReconcilerQueue;
  readonly #platform: NodeJS.Platform;
  readonly #nodeVersion: string;
  #snapshot: DaemonRegistrationSnapshot = { workspaces: [], repositories: [] };
  #watcher: DaemonWatcherLifecycle | null = null;
  #server: DaemonServerLifecycle | null = null;
  #starting: Promise<void> | null = null;
  #started = false;
  #closed = false;
  #watchRefreshPending = false;

  constructor(options: WtmDaemonOptions) {
    this.#stateStore = options.stateStore;
    this.#socketPath = options.socketPath;
    this.#processSupervisor = options.processSupervisor ?? null;
    this.#runtimeHandler = options.runtimeHandler ?? null;
    this.#recoveryHooks = {
      verifyProcessIdentities: options.recoveryHooks?.verifyProcessIdentities
        ?? (this.#processSupervisor === null ? noRecoveryWork : async () => {
          await this.#processSupervisor?.recover();
        }),
      verifyEndpointLeases: options.recoveryHooks?.verifyEndpointLeases ?? noRecoveryWork,
      scheduleCleanupRetries: options.recoveryHooks?.scheduleCleanupRetries ?? noRecoveryWork,
    };
    this.#adapterDiscovery = options.adapterDiscovery ?? noRecoveryWork;
    this.#onReconciled = options.onReconciled ?? noRecoveryWork;
    this.#onError = options.onError ?? (() => {});
    this.#listGitWorktrees = options.listGitWorktrees ?? defaultListGitWorktrees;
    this.#platform = options.platform ?? process.platform;
    this.#nodeVersion = options.nodeVersion ?? process.versions.node;
    this.#watcherFactory = options.watcherFactory ?? ((registrations, schedule) => new StructuralWatcher({
      registrations,
      schedule,
      ...(options.watchFactory === undefined ? {} : { watchFactory: options.watchFactory }),
      ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
      onError: this.#onError,
    }));
    this.#serverFactory = options.serverFactory ?? ((serverOptions) => new UnixIpcServer(serverOptions));
    this.#queue = new ReconcilerQueue({
      run: async (batch) => this.#runBatch(batch),
      onError: this.#onError,
    });
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('WTM daemon is closed'));
    if (this.#started) return Promise.resolve();
    if (this.#starting !== null) return this.#starting;
    this.#starting = this.#start().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = this.#queue.generation;
      await this.#watcher?.whenIdle();
      await this.#queue.flush();
      await this.#watcher?.whenIdle();
      await this.#queue.flush();
      if (this.#queue.idle && this.#queue.generation === generation) return;
    }
    throw new Error('WTM daemon reconciliation did not reach an idle fixed point');
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#starting;
    } catch {
      return;
    }
    let failure: unknown;
    try {
      await this.#closeResources();
    } catch (error) {
      failure = error;
    }
    try {
      await this.#queue.close();
    } catch (error) {
      failure ??= error;
    }
    this.#started = false;
    if (failure !== undefined) throw failure;
  }

  async #start(): Promise<void> {
    assertSupportedRuntime(this.#platform, this.#nodeVersion);
    try {
      this.#snapshot = await this.#availableRegistrations();
      await this.#recoveryHooks.verifyProcessIdentities(this.#snapshot);
      await this.#recoveryHooks.verifyEndpointLeases(this.#snapshot);
      await this.#recoveryHooks.scheduleCleanupRetries(this.#snapshot);
      if (this.#closed) throw new Error('WTM daemon closed during startup');
      // The socket opens before the first reconcile, not after it. Reading every registered
      // repository is the slowest thing the daemon ever does — one `git` per repository, each
      // with its own timeout — and a machine with a few dozen of them on a slow volume spent
      // minutes there. launchd reported the service as running the whole time while every
      // command in every workspace failed as `WTM_DAEMON_UNAVAILABLE`, with nothing to read
      // that said why. Answering from the last known topology is worse than answering from a
      // fresh one, and far better than not answering.
      this.#server = this.#serverFactory({
        socketPath: this.#socketPath,
        handler: async (request) => this.#handleRequest(request),
      });
      await this.#server.start();
      for (const failure of (await this.#reconcileRepositories(this.#snapshot.repositories)).failures) {
        this.#onError(failure);
      }
      if (this.#closed) throw new Error('WTM daemon closed during startup');
      await this.#replaceWatcher();
      // A close that arrives while the watcher is starting must not leave a daemon that calls
      // itself started, with a socket still accepting requests it can no longer serve.
      if (this.#closed) throw new Error('WTM daemon closed during startup');
      this.#started = true;
    } catch (error) {
      await this.#closeResourcesIgnoringErrors();
      await this.#queue.close();
      this.#closed = true;
      throw error;
    }
  }

  /**
   * The registrations whose directories are on disk right now.
   *
   * A registered root can disappear — a finished migration deleted, a volume unmounted, a
   * clone moved. Refusing to start over one of them denied every other workspace a daemon at
   * all, and because launchd restarts a service that exits non-zero, one deleted directory
   * became a permanent restart loop whose only trace was a line in a log nobody is pointed at.
   * The registration is kept, because the directory may well come back; it is simply left out
   * of this pass, and each disappearance is reported once.
   */
  async #availableRegistrations(): Promise<DaemonRegistrationSnapshot> {
    const loaded = this.#loadRegistrations();
    const workspaces = [];
    for (const workspace of loaded.workspaces) {
      const missing = await missingDirectory(workspace.root, 'workspace');
      if (missing === null) workspaces.push(workspace);
      else this.#onError(missing);
    }
    const workspaceIds = new Set(workspaces.map(({ id }) => id));
    const repositories = [];
    for (const repository of loaded.repositories) {
      if (!workspaceIds.has(repository.workspaceId)) continue;
      const missing = await missingDirectory(repository.mainRoot, 'repository')
        ?? await missingDirectory(repository.commonGitDir, 'Git common');
      if (missing === null) repositories.push(repository);
      else this.#onError(missing);
    }
    return { workspaces, repositories };
  }

  #loadRegistrations(): DaemonRegistrationSnapshot {
    const workspaces = this.#stateStore.listWorkspaces();
    const workspaceIds = new Set(workspaces.map(({ id }) => id));
    const repositories = this.#stateStore
      .listRepositories()
      .filter(({ workspaceId }) => workspaceIds.has(workspaceId));
    return { workspaces, repositories };
  }

  /**
   * A workspace spans many repositories, and any one of them can be unreadable at this
   * moment: an unmounted volume, a filesystem the process is not allowed to touch, a
   * repository mid-rebase. Letting that abort the pass would deny every other repository a
   * working daemon, so each failure is collected and the repository keeps its last known
   * topology until a later pass can refresh it. What the caller does with the collected
   * failures differs by caller, which is why they are returned rather than thrown here.
   */
  async #reconcileRepositories(
    repositories: readonly RepositoryRecord[],
  ): Promise<{ topologyChanged: boolean; failures: unknown[] }> {
    // Reading a repository is independent work that waits on git, so the readings overlap;
    // otherwise a workspace of ten repositories pays ten timeouts in a row when a volume goes
    // away. The results are applied afterwards in registration order, keeping every write to
    // the store and every reconcile notification in one deterministic sequence.
    const readings = await mapConcurrent(
      repositories,
      maxConcurrentRepositoryReads,
      async (repository) => {
        try {
          return { repository, snapshot: await this.#listGitWorktrees(repository.mainRoot) };
        } catch (error) {
          return { repository, error };
        }
      },
    );
    // A git that timed out was not necessarily refused. On a cold external volume the first
    // reads of a session are slow enough that eight of them at once all overrun the tight
    // per-repository bound, and the whole pass then reports nothing — which is how a
    // transient warm-up came to look like a daemon that could read nothing at all. The
    // overrun repositories are read once more, one at a time, so contention is removed as an
    // explanation before the failure is believed.
    const settled = await this.#retryTimedOutReads(readings);
    let topologyChanged = false;
    let read = 0;
    const failures: unknown[] = [];
    const unread: RepositoryRecord[] = [];
    for (const reading of settled) {
      if (reading.snapshot === undefined) {
        failures.push(reading.error);
        unread.push(reading.repository);
        continue;
      }
      read += 1;
      const result = this.#stateStore.reconcileWorktrees(reading.repository.id, reading.snapshot);
      if (result.discovered.length > 0 || result.orphaned.length > 0) topologyChanged = true;
      await this.#onReconciled({ repository: reading.repository, result });
    }
    if (read === 0 && failures.length > 0) this.#onError(await unreadableRepositories(unread, failures));
    return { topologyChanged, failures };
  }

  async #retryTimedOutReads(readings: readonly RepositoryReading[]): Promise<RepositoryReading[]> {
    if (!readings.some(timedOutReading)) return [...readings];
    const settled: RepositoryReading[] = [];
    for (const reading of readings) {
      if (!timedOutReading(reading)) {
        settled.push(reading);
        continue;
      }
      try {
        settled.push({
          repository: reading.repository,
          snapshot: await this.#listGitWorktrees(reading.repository.mainRoot, retriedWorktreeListTimeoutMs),
        });
      } catch (error) {
        settled.push({ repository: reading.repository, error });
      }
    }
    return settled;
  }

  async #runBatch(batch: ReconcileBatch): Promise<void> {
    if (batch.kinds.includes('watch-error')) this.#watchRefreshPending = true;
    const registrations = registrationKey(this.#snapshot);
    this.#snapshot = await this.#availableRegistrations();
    // A workspace registered or retired since the last pass changes what has to be watched.
    // Without this the set of watchers was fixed at whatever the daemon started with, and a
    // workspace added afterwards was reconciled — because this pass reads the refreshed
    // snapshot — but never observed, so only somebody else's activity ever refreshed it.
    if (registrationKey(this.#snapshot) !== registrations) this.#watchRefreshPending = true;
    const { topologyChanged, failures } = await this.#reconcileRepositories(this.#snapshot.repositories);
    if (batch.kinds.some((kind) => kind === 'config' || kind === 'manifest' || kind === 'fingerprint')) {
      await this.#adapterDiscovery(this.#snapshot);
    }
    if (topologyChanged) this.#watchRefreshPending = true;
    if (this.#watchRefreshPending && !this.#closed) {
      await this.#replaceWatcher();
      this.#watchRefreshPending = false;
    }
    // The rest of the batch still ran, so the daemon stays current for every repository that
    // could be read. Reporting the failure last is what tells someone who asked for a
    // reconcile that their answer is incomplete.
    if (failures.length > 0) throw failures[0];
  }

  async #replaceWatcher(): Promise<void> {
    const registrations = await buildWatchRegistrations(this.#stateStore, this.#snapshot);
    const replacement = this.#watcherFactory(registrations, (signal) => this.#queue.schedule(signal));
    await replacement.start();
    if (this.#closed) {
      await replacement.close();
      return;
    }
    const previous = this.#watcher;
    this.#watcher = replacement;
    await previous?.close();
  }

  async #handleRequest(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    if (request.command === 'ping') return successEnvelope('ping', { pid: process.pid });
    if (request.command === 'reconcile') {
      // Read the registrations again before scheduling. A workspace registered since the
      // daemon started is not in the snapshot yet, so a reconcile asked for immediately after
      // `wtm init` scheduled nothing for it, discovered none of its worktrees, and — because
      // watchers are built from the same snapshot — never would have: the new workspace was
      // invisible until the daemon happened to restart. Refreshing here is also what puts it
      // under a watcher, since the batch this schedules rebuilds them from what it finds.
      const previous = registrationKey(this.#snapshot);
      this.#snapshot = await this.#availableRegistrations();
      // Only when the set actually changed: rebuilding watchers on every reconcile request
      // tears down and re-establishes every watch for nothing.
      if (registrationKey(this.#snapshot) !== previous) this.#watchRefreshPending = true;
      for (const workspace of this.#snapshot.workspaces) {
        this.#queue.schedule({ root: workspace.root, kind: 'git-topology' });
      }
      await this.#queue.flush();
      return successEnvelope('reconcile', { workspaces: this.#snapshot.workspaces.length });
    }
    if (runtimeCommandNames.has(request.command) && this.#runtimeHandler !== null) {
      return await this.#runtimeHandler(request);
    }
    return {
      schemaVersion: 1,
      ok: false,
      command: request.command,
      data: null,
      warnings: [],
      errors: [{
        code: 'WTM_DAEMON_INVALID_REQUEST',
        message: 'Unknown daemon command.',
        severity: 'error',
      }],
    };
  }

  async #closeResources(): Promise<void> {
    const server = this.#server;
    const watcher = this.#watcher;
    this.#server = null;
    this.#watcher = null;
    let failure: unknown;
    for (const resource of [server, watcher, this.#processSupervisor]) {
      try {
        await resource?.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async #closeResourcesIgnoringErrors(): Promise<void> {
    const server = this.#server;
    const watcher = this.#watcher;
    this.#server = null;
    this.#watcher = null;
    for (const resource of [server, watcher, this.#processSupervisor]) {
      try {
        await resource?.close();
      } catch (error) {
        try {
          this.#onError(error);
        } catch {
          // Cleanup observers cannot prevent remaining resources from closing.
        }
      }
    }
  }
}

/**
 * Refused because WTM has no backend for this machine, said the way a user can act on.
 *
 * It extends `@wtm/platform`'s refusal rather than replacing it, so the code, the severity, the
 * context and the remediation are the seam's — one definition of what "unsupported platform"
 * means, reaching the JSON envelope as a coded error rather than as a bare string. Only the
 * message differs, because the daemon can say the one thing the seam cannot: *when* the missing
 * platform is being decided. A user reading "WTM has no backend for win32" learns that it does not
 * work; a user reading this learns that Windows is a known, scheduled piece of work, which is the
 * difference between filing a bug and waiting for a release.
 */
export class UnsupportedDaemonPlatformError extends UnsupportedPlatformError {
  constructor(platform: string) {
    super(platform);
    this.name = 'UnsupportedDaemonPlatformError';
    this.message = `The WTM daemon has no backend for ${platform}. It runs on `
      + `${supportedPlatforms.join(' and ')}; Windows support is Increment D, which decides `
      + 'process-group and service-manager semantics together rather than one call site at a time.';
  }
}

/**
 * The platforms are `@wtm/platform`'s list, not a copy of it.
 *
 * This line used to read `platform !== 'darwin'`, and the message it raised — "WTM V1 daemon
 * requires macOS" — was the last statement in the daemon that treated one operating system as the
 * product's requirement. A second list here would be a second thing to remember when a platform is
 * added, and the whole reason a `supportedPlatforms` export exists is that the seam is the place
 * that answers this.
 */
export function assertSupportedRuntime(platform: NodeJS.Platform, nodeVersion: string): void {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 24) throw new Error('WTM daemon requires Node.js 24 or newer');
  if (!(supportedPlatforms as readonly string[]).includes(platform)) {
    throw new UnsupportedDaemonPlatformError(platform);
  }
}

/**
 * Enough concurrency to hide the latency of a workspace-sized set of repositories without
 * spawning an unbounded number of git processes on a very large one.
 */
const maxConcurrentRepositoryReads = 8;

/** One repository's reading: the topology it reported, or why it could not be taken. */
interface RepositoryReading {
  repository: RepositoryRecord;
  snapshot?: GitWorktreeRecord[];
  error?: unknown;
}

/** Runs `action` over `items` at most `limit` at a time, preserving input order in the result. */
async function mapConcurrent<Item, Result>(
  items: readonly Item[],
  limit: number,
  action: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await action(items[index] as Item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One named condition in place of N identical failures, and the evidence for it.
 *
 * When not a single repository could be read, these are not independent problems; they are one
 * problem. Naming the likeliest one was not good enough: the message asserted that macOS had
 * withheld disk access, an assertion nothing had tested, and on the machine that prompted it
 * the real cause was a cold USB volume whose first reads simply took longer than the bound.
 * Acting on that message means granting a background agent access to every file on the disk,
 * which is far too large a thing to advise on a guess. So the guess is replaced by a reading:
 * the directories are opened directly, and only a refusal to open them is reported as one.
 */
async function unreadableRepositories(
  repositories: readonly RepositoryRecord[],
  failures: readonly unknown[],
): Promise<Error> {
  const count = failures.length;
  const subject = `None of ${count} registered ${count === 1 ? 'repository' : 'repositories'}`;
  const refused = await refusedDirectory(repositories);
  if (refused !== null) {
    return new Error(`${subject} could be read: ${refused} could not be opened either `
      + '(EACCES). A daemon launched by launchd holds no file-access grant of its own. Grant '
      + 'it once in System Settings > Privacy & Security > Full Disk Access, to the installed '
      + 'wtm executable. Until then WTM answers from the topology it last read.');
  }
  if (failures.every(readTimedOut)) {
    return new Error(`${subject} could be read: every git command overran its bound, twice, `
      + 'although the directories themselves open normally — so this is a filesystem that is '
      + 'answering too slowly rather than one WTM is not allowed to read. A cold external '
      + 'volume does this while it spins up. WTM answers from the topology it last read and '
      + 'reads again on the next change.');
  }
  return new Error(`${subject} could be read this pass; WTM answers from the topology it last read.`);
}

/** The first registered root that exists but refuses to be opened, or `null` when none does. */
async function refusedDirectory(repositories: readonly RepositoryRecord[]): Promise<string | null> {
  for (const repository of repositories) {
    try { await readdir(repository.mainRoot); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return repository.mainRoot;
    }
  }
  return null;
}

function readTimedOut(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null
    && 'timedOut' in failure && failure.timedOut === true;
}

function timedOutReading(reading: RepositoryReading): boolean {
  return reading.snapshot === undefined && readTimedOut(reading.error);
}

/** What the watchers were built from, so a rebuild happens only when that has changed. */
function registrationKey(snapshot: DaemonRegistrationSnapshot): string {
  return [
    ...snapshot.workspaces.map(({ id, root }) => `w:${id}:${root}`),
    ...snapshot.repositories.map(({ id, mainRoot }) => `r:${id}:${mainRoot}`),
  ].sort().join('\n');
}

/** Why a registered root cannot be used this pass, or `null` when it can. */
async function missingDirectory(path: string, kind: string): Promise<Error | null> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    // A root that is refused is not a root that is gone, and calling both "unavailable" hid
    // the only condition a person can actually do something about behind the one they cannot.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return new Error(`Registered ${kind} root cannot be opened: ${path} (${code}). A daemon `
        + 'launched by launchd holds no file-access grant of its own; grant it once in System '
        + 'Settings > Privacy & Security > Full Disk Access, to the installed wtm executable.');
    }
    // The registration is deliberately kept — an unmounted volume comes back — but a root that
    // has genuinely gone reports this on every pass forever, so the line says how to end it.
    return new Error(`Registered ${kind} root is unavailable: ${path}`
      + ' (the registration is kept in case it returns; retire it with `wtm forget`)');
  }
  return stat.isDirectory() ? null : new Error(`Registered ${kind} root is not a directory: ${path}`);
}

async function buildWatchRegistrations(
  stateStore: DaemonStateStore,
  snapshot: DaemonRegistrationSnapshot,
): Promise<WorkspaceWatchRegistration[]> {
  const registrations: WorkspaceWatchRegistration[] = [];
  for (const workspace of snapshot.workspaces) {
    const repositories = [];
    for (const repository of snapshot.repositories.filter(({ workspaceId }) => workspaceId === workspace.id)) {
      const worktreePaths: string[] = [];
      for (const worktree of stateStore.listWorktrees(repository.id)) {
        if (worktree.state === 'ORPHANED' || worktree.state === 'REMOVED') continue;
        try {
          if ((await lstat(worktree.path)).isDirectory()) worktreePaths.push(worktree.path);
        } catch {
          // The Git snapshot remains authoritative; absent paths are not watched.
        }
      }
      repositories.push({
        mainRoot: repository.mainRoot,
        commonGitDir: repository.commonGitDir,
        worktreePaths,
      });
    }
    registrations.push({ workspaceRoot: workspace.root, repositories });
  }
  return registrations;
}

function successEnvelope(command: string, data: unknown): JsonEnvelope<unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    data,
    warnings: [],
    errors: [],
  };
}
