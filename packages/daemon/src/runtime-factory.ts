import { homedir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { jobCommandNames } from '@wtm/protocol';
import { basename as posixBasename, dirname as posixDirname, join as posixJoin, resolve as posixResolve } from 'node:path/posix';
import { basename as win32Basename, dirname as win32Dirname, join as win32Join, resolve as win32Resolve } from 'node:path/win32';
import { readHeavyJobScope, selectPlatformRuntime, windowsNamedPipeRootFor } from '@wtm/platform';
import type { PlatformId, PlatformRuntime } from '@wtm/platform/ports';
import {
  assertDaemonSocketPathFits,
  daemonSocketFileName,
} from '@wtm/platform/socket';
import {
  SQLiteStateStore,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  resolveTask,
  containsPath,
  HeavyJobError,
  parseWtmConfig,
  queueTaskTimeoutMs,
  type DaemonStateStore,
  type LifecycleEventStore,
  type WtmConfig,
} from '@wtm/core';
import { LifecycleEventDispatcher } from './events';
import { WtmDaemon } from './main';
import { ManagedLogStore } from './logs';
import { HeavyJobQueue, type ResolvedHeavyJob } from './heavy-job-queue';
import { ManagedProcessSupervisor, type RuntimeInvocation } from './process-supervisor';
import { DaemonRuntimeController, type DaemonRuntimeResolver } from './runtime-controller';
import {
  execEnvironment,
  findRegistration,
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
} from './task-resolution';

export interface ProductionRuntimePaths {
  dataRoot: string;
  databasePath: string;
  socketPath: string;
  logRoot: string;
  globalConfigPath: string;
}

export interface ProductionDaemonOptions {
  /**
   * The machine this daemon is running on. Injected so a test can run the Linux policy on a macOS
   * host; production selects it here, which is what makes this function the composition root.
   */
  platformRuntime?: PlatformRuntime;
  dataRoot?: string;
  databasePath?: string;
  socketPath?: string;
  logRoot?: string;
  globalConfigPath?: string;
  stateStore?: DaemonStateStore & { close?(): void };
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
  runtimeInvocation?: RuntimeInvocation;
}

export interface ProductionDaemonRuntime {
  paths: ProductionRuntimePaths;
  stateStore: DaemonStateStore;
  logs: ManagedLogStore;
  supervisor: ManagedProcessSupervisor;
  controller: DaemonRuntimeController;
  daemon: WtmDaemon;
  jobs: HeavyJobQueue | null;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The state database's file name. Only its directory is a platform question. */
const databaseFileName = 'state.db';

/**
 * The `node:path` module for `platform`'s filesystem rules, not the host's.
 *
 * A real CI run surfaced this the same way `select.ts` already needed it: the default `node:path`
 * follows the *host*, so building `databasePath`/`socketPath`/`globalConfigPath` with a plain
 * `join`/`resolve` mangled a POSIX `dataRoot` like `/Users/somebody/Library/...` into
 * `\Users\somebody\Library\...` on a Windows host asked for the `darwin`/`linux` runtime
 * `runtime-factory.test.ts` (and `createProductionDaemon`'s own `platformRuntime` injection point)
 * construct. Every path built in this file from an already-resolved `PlatformRuntime`'s roots goes
 * through this instead of the default import.
 */
function pathModuleFor(platform: PlatformId) {
  return platform === 'win32'
    ? { join: win32Join, resolve: win32Resolve, dirname: win32Dirname, basename: win32Basename }
    : { join: posixJoin, resolve: posixResolve, dirname: posixDirname, basename: posixBasename };
}

export interface ProductionRuntimePathsOptions {
  platform?: NodeJS.Platform | string;
  env?: Readonly<Partial<Record<string, string>>>;
}

/**
 * The daemon's five paths, read off a platform runtime.
 *
 * Every root used to be spelled here: `~/Library/Application Support/WTM`, `~/Library/Logs/WTM`,
 * and a socket path derived from the data root. Two of those are macOS facts and the third is a
 * macOS coincidence — the socket sits beside the database on macOS because macOS offers nowhere
 * shorter to put it, whereas on Linux `$XDG_RUNTIME_DIR` is a different filesystem chosen by a
 * different variable. So `socketPath` comes from `paths.socketRoot`, which is why `PlatformPaths`
 * states that as a field rather than leaving it to be derived: a derivation from `dataRoot` would
 * be silently wrong on Linux and there would be nothing in the type to say so.
 */
export function runtimePathsFor(runtime: PlatformRuntime): ProductionRuntimePaths {
  const { paths } = runtime;
  const { join } = pathModuleFor(runtime.id);
  return {
    dataRoot: paths.dataRoot,
    databasePath: join(paths.dataRoot, databaseFileName),
    socketPath: join(paths.socketRoot, daemonSocketFileName),
    logRoot: paths.logRoot,
    globalConfigPath: paths.configPath,
  };
}

/**
 * `home` stays a positional argument with a default because the CLI calls this a dozen times with
 * no arguments at all; `platform` and `env` are injectable for the same reason every port in
 * `@wtm/platform` takes them, which is that the Linux layout has to be assertable from this macOS
 * machine. `selectPlatformRuntime` is also where `home` is validated, once, for every port.
 */
export function defaultProductionRuntimePaths(
  home = homedir(),
  options: ProductionRuntimePathsOptions = {},
): ProductionRuntimePaths {
  return runtimePathsFor(selectPlatformRuntime({ home, ...options }));
}

/** Pure path resolution shared by production startup and cross-platform validation. */
export function resolveProductionRuntimePaths(
  platformRuntime: PlatformRuntime,
  options: Pick<ProductionDaemonOptions, 'dataRoot' | 'databasePath' | 'socketPath' | 'logRoot' | 'globalConfigPath'> = {},
): ProductionRuntimePaths {
  const { join, resolve } = pathModuleFor(platformRuntime.id);
  const defaults = runtimePathsFor(platformRuntime);
  const dataRoot = resolve(options.dataRoot ?? defaults.dataRoot);
  return {
    dataRoot,
    databasePath: resolve(options.databasePath ?? join(dataRoot, databaseFileName)),
    // A caller who moved the data root gets its socket moved with it, even on a platform whose
    // default socket root is elsewhere: an isolated instance that kept the shared
    // `$XDG_RUNTIME_DIR` address would collide with the installed daemon, which is the one
    // failure a caller passing `dataRoot` is trying to avoid. Only the untouched default reads
    // the platform's socket root.
    socketPath: resolve(options.socketPath
      ?? (options.dataRoot === undefined ? defaults.socketPath
        : join(platformRuntime.id === 'win32' ? windowsNamedPipeRootFor(dataRoot) : dataRoot, daemonSocketFileName))),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    globalConfigPath: resolve(options.globalConfigPath ?? join(dataRoot, 'config.toml')),
  };
}

export async function createProductionDaemon(options: ProductionDaemonOptions = {}): Promise<ProductionDaemonRuntime> {
  const platformRuntime = options.platformRuntime ?? selectPlatformRuntime();
  const { join, dirname, basename } = pathModuleFor(platformRuntime.id);
  const requestedPaths = resolveProductionRuntimePaths(platformRuntime, options);
  const { dataRoot } = requestedPaths;
  // Before the data directory exists. A socket path that cannot fit in a socket address is
  // not a reason to bring a state directory, a database and a log root into being first, and
  // failing here means the report names the path rather than whatever the next step tripped on.
  // The limit is the selected platform's — 104 bytes on macOS, 108 on Linux — rather than a
  // constant: measuring a Linux path against macOS's number refuses addresses that would bind.
  assertDaemonSocketPathFits(requestedPaths.socketPath, platformRuntime.socket.limitBytes);
  // Both calls below default to `defaultCoreFileTrustPolicy` (core's POSIX-only fallback) when
  // not given one explicitly, and that default's `currentIdentityAvailable()` is
  // `process.getuid?.() !== undefined` -- always `false` on win32. Omitting `platformRuntime
  // .fileTrust` here meant the composition root that exists specifically to select the right
  // trust policy never reached these two calls at all, so a real Windows daemon would refuse to
  // create its own data root on every single start -- confirmed on a real windows-latest leg.
  await ensurePrivateDirectory(dataRoot, platformRuntime.fileTrust);
  const ownedStore = options.stateStore === undefined;
  const databaseParent = ownedStore
    ? await ensurePrivateDirectory(dirname(requestedPaths.databasePath), platformRuntime.fileTrust)
    : undefined;
  const paths: ProductionRuntimePaths = {
    ...requestedPaths,
    databasePath: databaseParent === undefined
      ? requestedPaths.databasePath
      : join(databaseParent.path, basename(requestedPaths.databasePath)),
  };
  const stateStore = options.stateStore ?? new SQLiteStateStore(paths.databasePath);
  if (databaseParent !== undefined) {
    try { await verifyPrivateDirectory(databaseParent, platformRuntime.fileTrust); }
    catch (error) {
      (stateStore as SQLiteStateStore).close();
      throw error;
    }
  }
  let queueScope: string | null = null;
  if (stateStore.jobs !== undefined) {
    try { queueScope = await readHeavyJobScope(platformRuntime.id); stateStore.jobs.assertScope(queueScope); }
    catch (error) { if (ownedStore) (stateStore as SQLiteStateStore).close(); throw error; }
  }
  const logs = new ManagedLogStore({
    root: paths.logRoot,
    // The same reason `supervisor` below is handed `platformRuntime.process` rather than reading
    // the host itself: the composition root already chose a platform, and a log store answering
    // its own directory-safety questions from a different one is the class of drift this seam
    // exists to remove.
    fileTrust: platformRuntime.fileTrust,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  let jobs: HeavyJobQueue | null = null;
  const supervisor = new ManagedProcessSupervisor({
    stateStore,
    logs,
    onExit: (record, outcome) => { jobs?.recordExit(record, outcome); },
    // The supervisor's own defaults read the host, which is right for a daemon nobody handed a
    // runtime to and wrong for this one: the composition root has already chosen a platform, and
    // a supervisor inspecting processes through a different one than the daemon was built for is
    // the exact class of drift the seam exists to remove.
    //
    // `platform` is part of that and was missing while the two readers below were not, which made
    // the omission invisible: the readers are what a *test* observes, and the platform is what the
    // spawned anchor is told. An injected runtime for the other platform — which
    // `runtime-factory.test.ts` constructs — would have produced an anchor reporting its identity
    // in the host's dialect and a port reading it in the injected one, and the two dialects cannot
    // compare equal. That surfaces as `ANCHOR_IDENTITY_MISMATCH`, which blames the process for
    // changing identity when in fact nobody ever asked it the same question twice.
    platform: platformRuntime.id,
    inspectProcess: async (pid) => await platformRuntime.process.inspectProcess(pid),
    inspectProcessGroup: async (pgid) => await platformRuntime.process.inspectProcessGroup(pgid),
    signalProcessGroup: (pgid, signal) => { platformRuntime.process.signalProcessGroup(pgid, signal); },
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.runtimeInvocation === undefined ? {} : { runtimeInvocation: options.runtimeInvocation }),
  });
  const onError = options.onError ?? (() => {});
  const events = new LifecycleEventDispatcher({
    store: stateStore as DaemonStateStore & LifecycleEventStore,
    globalConfigPath: paths.globalConfigPath,
    start: async (input) => await supervisor.start(input),
    onError,
  });
  const resolver = new ProductionRuntimeResolver(stateStore, paths.globalConfigPath, (worktreeId) => {
    // Announced once per worktree, whichever timing prepared it: `eager` at discovery, `lazy`
    // here, before the first task. Dispatched without being awaited so that an event's own
    // task cannot be waiting on the start that is waiting on it.
    void events.dispatchForWorktree('worktree.ready', worktreeId).catch(onError);
  });
  const controller = new DaemonRuntimeController({
    supervisor,
    logs,
    resolver,
    inspectProcess: async (pid) => await platformRuntime.process.inspectProcess(pid),
    // Dispatching an event must not delay the reply to the person who started the task, and
    // must not fail it either: the task started, whatever the workspace hung off the event did.
    onRuntimeEvent: (event, worktreeId) => {
      void events.dispatchForWorktree(event, worktreeId).catch(onError);
    },
  });
  if (stateStore.jobs !== undefined) {
    const jobPolicy = await globalJobPolicy(paths.globalConfigPath);
    jobs = new HeavyJobQueue({
      store: stateStore.jobs,
      scope: queueScope!,
      supervisor, logs, maxConcurrent: jobPolicy.max_concurrent_heavy ?? 1, onError,
      ...(jobPolicy.memory === undefined ? {} : { memory: {
        budgetBytes: jobPolicy.memory.budget_mib * 1024 * 1024,
        reserveBytes: (jobPolicy.memory.reserve_mib ?? 1024) * 1024 * 1024,
      } }),
      inspectGroup: async (pgid) => await platformRuntime.process.inspectProcessGroup(pgid),
      resolveTask: async (cwd, taskName) => resolveHeavyJob(stateStore, paths.globalConfigPath, cwd, taskName),
    });
  }
  const daemon = new WtmDaemon({
    stateStore,
    socketPath: paths.socketPath,
    processSupervisor: {
      recover: async () => supervisor.recover(),
      close: async () => { await jobs?.close(); await supervisor.close(); },
    },
    runtimeHandler: async (request, context) => jobCommandNames.has(request.command) && jobs !== null ? jobs.handle(request) : controller.handle(request, context),
    // Preparation and lifecycle events belong to the pass that noticed the change, so a
    // worktree created while WTM is watching is prepared before anybody runs anything in it.
    onReconciled: async ({ repository, result }) => {
      try {
        await events.onReconciled(repository, result);
      } catch (error) {
        onError(error);
      }
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  let closed = false;
  return {
    paths,
    stateStore,
    logs,
    supervisor,
    controller,
    daemon,
    jobs,
    start: async () => { await daemon.start(); await jobs?.start(); },
    close: async () => {
      if (closed) return;
      closed = true;
      try { await daemon.close(); }
      finally { if (ownedStore) (stateStore as SQLiteStateStore).close(); }
    },
  };
}

async function globalJobPolicy(path: string): Promise<NonNullable<WtmConfig['jobs']>> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseWtmConfig(parse(value), path).jobs ?? {};
}

async function resolveHeavyJob(store: DaemonStateStore, globalConfigPath: string, cwd: string, taskName: string): Promise<ResolvedHeavyJob> {
  const runtime = await resolveWorktreeRuntime({ store, globalConfigPath, cwd, allocate: false });
  const configured = runtime.config.tasks?.[taskName];
  const timeoutMs = queueTaskTimeoutMs(configured?.timeout);
  if (configured?.queue !== true || configured.background === true || timeoutMs === null) {
    throw new HeavyJobError('WTM_JOB_NOT_QUEUEABLE', 'Queue tasks require queue=true, a finite timeout, and background=false.', { taskName });
  }
  const task = resolveTask({ ...taskResolutionInput(runtime, taskName), executionMode: 'queued' });
  const root = await realpath(runtime.registration.worktree.path);
  const taskCwd = await realpath(task.cwd);
  if (!containsPath(root, taskCwd)) throw new HeavyJobError('WTM_JOB_NOT_QUEUEABLE', 'Queued task working directory must stay inside its worktree.', { taskName });
  return {
    workspaceId: runtime.registration.workspace.id, repositoryId: runtime.registration.repository.id,
    worktreeId: runtime.registration.worktree.id, worktreePath: runtime.registration.worktree.path,
    taskName, timeoutMs, argv: task.argv, cwd: taskCwd, shell: task.shell,
    memoryEstimateBytes: configured.memory_estimate_mib === undefined ? null : configured.memory_estimate_mib * 1024 * 1024,
    env: { ...process.env, ...task.envDelta },
  };
}

class ProductionRuntimeResolver implements DaemonRuntimeResolver {
  constructor(
    private readonly store: DaemonStateStore,
    private readonly globalConfigPath: string,
    private readonly onPrepared: (worktreeId: string) => void = () => {},
  ) {}

  async resolveTask(cwd: string, taskName: string) {
    const runtime = await this.#runtime(cwd);
    // A task that reads `.env` needs `.env` to be there. Under `[prepare] mode = "lazy"`, the
    // default, this is the moment the worktree is prepared; `eager` will already have done it
    // at discovery, and preparing again creates nothing that is already there.
    await prepareRuntimeResources(runtime);
    this.onPrepared(runtime.registration.worktree.id);
    return {
      workspaceId: runtime.registration.workspace.id,
      worktreeId: runtime.registration.worktree.id,
      task: resolveTask(taskResolutionInput(runtime, taskName)),
    };
  }

  async resolveWorktree(cwd: string) {
    const registration = findRegistration(this.store, cwd);
    const repositoryIds = new Set(this.store.listRepositories(registration.workspace.id).map(({ id }) => id));
    return {
      workspaceId: registration.workspace.id,
      worktreeId: registration.worktree.id,
      workspaceWorktreeIds: this.store.listWorktrees()
        .filter(({ repositoryId }) => repositoryIds.has(repositoryId))
        .map(({ id }) => id),
    };
  }

  async resolveExec(cwd: string) {
    const runtime = await this.#runtime(cwd);
    // Raw argv runs in the same worktree a task would, so it finds the same resources.
    await prepareRuntimeResources(runtime);
    this.onPrepared(runtime.registration.worktree.id);
    return {
      cwd: runtime.registration.worktree.path,
      envDelta: execEnvironment(runtime),
    };
  }

  async #runtime(cwd: string) {
    return await resolveWorktreeRuntime({
      store: this.store,
      cwd,
      globalConfigPath: this.globalConfigPath,
    });
  }
}
