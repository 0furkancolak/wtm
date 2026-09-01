import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  SQLiteStateStore,
  assertDaemonSocketPathFits,
  daemonDataRoot,
  daemonSocketFileName,
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

export function defaultProductionRuntimePaths(home = homedir()): ProductionRuntimePaths {
  const dataRoot = daemonDataRoot(home);
  return {
    dataRoot,
    databasePath: join(dataRoot, 'state.db'),
    socketPath: join(dataRoot, daemonSocketFileName),
    logRoot: join(home, 'Library', 'Logs', 'WTM'),
    globalConfigPath: join(dataRoot, 'config.toml'),
  };
}

export async function createProductionDaemon(options: ProductionDaemonOptions = {}): Promise<ProductionDaemonRuntime> {
  const defaults = defaultProductionRuntimePaths();
  const dataRoot = resolve(options.dataRoot ?? defaults.dataRoot);
  const requestedPaths: ProductionRuntimePaths = {
    dataRoot,
    databasePath: resolve(options.databasePath ?? join(dataRoot, 'state.db')),
    socketPath: resolve(options.socketPath ?? join(dataRoot, daemonSocketFileName)),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    globalConfigPath: resolve(options.globalConfigPath ?? join(dataRoot, 'config.toml')),
  };
  // Before the data directory exists. A socket path that cannot fit in a socket address is
  // not a reason to bring a state directory, a database and a log root into being first, and
  // failing here means the report names the path rather than whatever the next step tripped on.
  assertDaemonSocketPathFits(requestedPaths.socketPath);
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
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const supervisor = new ManagedProcessSupervisor({
    stateStore,
    logs,
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
