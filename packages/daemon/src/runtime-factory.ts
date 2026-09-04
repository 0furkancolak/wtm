import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
import {
  assertDaemonSocketPathFits,
  daemonSocketFileName,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import {
  SQLiteStateStore,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  resolveTask,
  type DaemonStateStore,
  type LifecycleEventStore,
} from '@wtm/core';
import { LifecycleEventDispatcher } from './events';
import { WtmDaemon } from './main';
import { ManagedLogStore } from './logs';
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
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The state database's file name. Only its directory is a platform question. */
const databaseFileName = 'state.db';

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
  return {
    dataRoot: paths.dataRoot,
    databasePath: join(paths.dataRoot, databaseFileName),
    socketPath: publishedDaemonSocketPath(paths.socketRoot),
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

export async function createProductionDaemon(options: ProductionDaemonOptions = {}): Promise<ProductionDaemonRuntime> {
  const platformRuntime = options.platformRuntime ?? selectPlatformRuntime();
  const defaults = runtimePathsFor(platformRuntime);
  const dataRoot = resolve(options.dataRoot ?? defaults.dataRoot);
  const requestedPaths: ProductionRuntimePaths = {
    dataRoot,
    databasePath: resolve(options.databasePath ?? join(dataRoot, databaseFileName)),
    // A caller who moved the data root gets its socket moved with it, even on a platform whose
    // default socket root is elsewhere: an isolated instance that kept the shared
    // `$XDG_RUNTIME_DIR` address would collide with the installed daemon, which is the one
    // failure a caller passing `dataRoot` is trying to avoid. Only the untouched default reads
    // the platform's socket root.
    socketPath: resolve(options.socketPath
      ?? (options.dataRoot === undefined ? defaults.socketPath : join(dataRoot, daemonSocketFileName))),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    globalConfigPath: resolve(options.globalConfigPath ?? join(dataRoot, 'config.toml')),
  };
  // Before the data directory exists. A socket path that cannot fit in a socket address is
  // not a reason to bring a state directory, a database and a log root into being first, and
  // failing here means the report names the path rather than whatever the next step tripped on.
  // The limit is the selected platform's — 104 bytes on macOS, 108 on Linux — rather than a
  // constant: measuring a Linux path against macOS's number refuses addresses that would bind.
  assertDaemonSocketPathFits(requestedPaths.socketPath, platformRuntime.socket.limitBytes);
  await ensurePrivateDirectory(dataRoot);
  const ownedStore = options.stateStore === undefined;
  const databaseParent = ownedStore
    ? await ensurePrivateDirectory(dirname(requestedPaths.databasePath))
    : undefined;
  const paths: ProductionRuntimePaths = {
    ...requestedPaths,
    databasePath: databaseParent === undefined
      ? requestedPaths.databasePath
      : join(databaseParent.path, basename(requestedPaths.databasePath)),
  };
  const stateStore = options.stateStore ?? new SQLiteStateStore(paths.databasePath);
  if (databaseParent !== undefined) {
    try { await verifyPrivateDirectory(databaseParent); }
    catch (error) {
      (stateStore as SQLiteStateStore).close();
      throw error;
    }
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
  const supervisor = new ManagedProcessSupervisor({
    stateStore,
    logs,
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
    // Dispatching an event must not delay the reply to the person who started the task, and
    // must not fail it either: the task started, whatever the workspace hung off the event did.
    onRuntimeEvent: (event, worktreeId) => {
      void events.dispatchForWorktree(event, worktreeId).catch(onError);
    },
  });
  const daemon = new WtmDaemon({
    stateStore,
    socketPath: paths.socketPath,
    processSupervisor: supervisor,
    runtimeHandler: async (request) => controller.handle(request),
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
    start: async () => daemon.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      try { await daemon.close(); }
      finally { if (ownedStore) (stateStore as SQLiteStateStore).close(); }
    },
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
