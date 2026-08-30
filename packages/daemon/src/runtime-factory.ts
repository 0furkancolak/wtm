import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  SQLiteStateStore,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  resolveTask,
  type DaemonStateStore,
} from '@wtm/core';
import { WtmDaemon } from './main';
import { ManagedLogStore } from './logs';
import { ManagedProcessSupervisor, type RuntimeInvocation } from './process-supervisor';
import { DaemonRuntimeController, type DaemonRuntimeResolver } from './runtime-controller';
import {
  execEnvironment,
  findRegistration,
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
  const dataRoot = join(home, 'Library', 'Application Support', 'WTM');
  return {
    dataRoot,
    databasePath: join(dataRoot, 'state.db'),
    socketPath: join(dataRoot, 'wtmd.sock'),
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
    socketPath: resolve(options.socketPath ?? join(dataRoot, 'wtmd.sock')),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    globalConfigPath: resolve(options.globalConfigPath ?? join(dataRoot, 'config.toml')),
  };
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
  const resolver = new ProductionRuntimeResolver(stateStore, paths.globalConfigPath);
  const controller = new DaemonRuntimeController({ supervisor, logs, resolver });
  const daemon = new WtmDaemon({
    stateStore,
    socketPath: paths.socketPath,
    processSupervisor: supervisor,
    runtimeHandler: async (request) => controller.handle(request),
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
  ) {}

  async resolveTask(cwd: string, taskName: string) {
    const runtime = await this.#runtime(cwd);
    return {
      workspaceId: runtime.registration.workspace.id,
      worktreeId: runtime.registration.worktree.id,
      task: resolveTask(taskResolutionInput(runtime, taskName)),
    };
  }

  async resolveWorktree(cwd: string) {
    const registration = findRegistration(this.store, cwd);
    return { workspaceId: registration.workspace.id, worktreeId: registration.worktree.id };
  }

  async resolveExec(cwd: string) {
    const runtime = await this.#runtime(cwd);
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
