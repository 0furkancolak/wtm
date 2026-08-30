import { lstat } from 'node:fs/promises';
import {
  listGitWorktrees as defaultListGitWorktrees,
  type DaemonStateStore,
  type GitWorktreeRecord,
  type ReconcileResult,
  type RepositoryRecord,
  type WorkspaceRecord,
} from '@wtm/core';
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
  listGitWorktrees?: (repositoryRoot: string) => Promise<GitWorktreeRecord[]>;
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
      this.#snapshot = this.#loadRegistrations();
      await validateRegistrationRoots(this.#snapshot);
      // Startup is the one pass that must finish: the IPC socket opens at the end of it, so
      // a repository that cannot be read here would otherwise leave every command in the
      // workspace facing a daemon that never starts listening.
      for (const failure of (await this.#reconcileRepositories(this.#snapshot.repositories)).failures) {
        this.#onError(failure);
      }
      await this.#recoveryHooks.verifyProcessIdentities(this.#snapshot);
      await this.#recoveryHooks.verifyEndpointLeases(this.#snapshot);
      await this.#recoveryHooks.scheduleCleanupRetries(this.#snapshot);
      await this.#replaceWatcher();
      if (this.#closed) throw new Error('WTM daemon closed during startup');
      this.#server = this.#serverFactory({
        socketPath: this.#socketPath,
        handler: async (request) => this.#handleRequest(request),
      });
      await this.#server.start();
      this.#started = true;
    } catch (error) {
      await this.#closeResourcesIgnoringErrors();
      await this.#queue.close();
      this.#closed = true;
      throw error;
    }
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
    let topologyChanged = false;
    const failures: unknown[] = [];
    for (const reading of readings) {
      if (reading.snapshot === undefined) {
        failures.push(reading.error);
        continue;
      }
      const result = this.#stateStore.reconcileWorktrees(reading.repository.id, reading.snapshot);
      if (result.discovered.length > 0 || result.orphaned.length > 0) topologyChanged = true;
      await this.#onReconciled({ repository: reading.repository, result });
    }
    return { topologyChanged, failures };
  }

  async #runBatch(batch: ReconcileBatch): Promise<void> {
    if (batch.kinds.includes('watch-error')) this.#watchRefreshPending = true;
    this.#snapshot = this.#loadRegistrations();
    await validateRegistrationRoots(this.#snapshot);
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

export function assertSupportedRuntime(platform: NodeJS.Platform, nodeVersion: string): void {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 24) throw new Error('WTM daemon requires Node.js 24 or newer');
  if (platform !== 'darwin') throw new Error('WTM V1 daemon requires macOS');
}

/**
 * Enough concurrency to hide the latency of a workspace-sized set of repositories without
 * spawning an unbounded number of git processes on a very large one.
 */
const maxConcurrentRepositoryReads = 8;

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

async function validateRegistrationRoots(snapshot: DaemonRegistrationSnapshot): Promise<void> {
  for (const workspace of snapshot.workspaces) await assertDirectory(workspace.root, 'workspace');
  for (const repository of snapshot.repositories) {
    await assertDirectory(repository.mainRoot, 'repository');
    await assertDirectory(repository.commonGitDir, 'Git common');
  }
}

async function assertDirectory(path: string, kind: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new Error(`Registered ${kind} root is unavailable: ${path}`);
  }
  if (!stat.isDirectory()) throw new Error(`Registered ${kind} root is not a directory: ${path}`);
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
