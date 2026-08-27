import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  SQLiteStateStore,
  resolveEnvironment,
  resolveTask,
  resolveWorkspaceConfig,
  type DaemonStateStore,
  type RepositoryRecord,
  type TemplateContext,
  type WorkspaceRecord,
  type WorktreeRecord,
} from '@wtm/core';
import { WtmDaemon } from './main';
import { ManagedLogStore } from './logs';
import { ManagedProcessSupervisor } from './process-supervisor';
import { DaemonRuntimeController, type DaemonRuntimeResolver } from './runtime-controller';

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
  const paths: ProductionRuntimePaths = {
    dataRoot,
    databasePath: resolve(options.databasePath ?? join(dataRoot, 'state.db')),
    socketPath: resolve(options.socketPath ?? join(dataRoot, 'wtmd.sock')),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    globalConfigPath: resolve(options.globalConfigPath ?? join(dataRoot, 'config.toml')),
  };
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const ownedStore = options.stateStore === undefined;
  const stateStore = options.stateStore ?? new SQLiteStateStore(paths.databasePath);
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
    const registration = this.#registration(cwd);
    const config = await resolveWorkspaceConfig({
      workspaceRoot: registration.workspace.root,
      repoRoot: registration.worktree.path,
      globalConfigPath: this.globalConfigPath,
    });
    return {
      worktreeId: registration.worktree.id,
      task: resolveTask({
        config: config.value,
        taskName,
        isMain: registration.worktree.isMain,
        context: templateContext(registration),
      }),
    };
  }

  async resolveWorktree(cwd: string) {
    return { worktreeId: this.#registration(cwd).worktree.id };
  }

  async resolveExec(cwd: string) {
    const registration = this.#registration(cwd);
    const config = await resolveWorkspaceConfig({
      workspaceRoot: registration.workspace.root,
      repoRoot: registration.worktree.path,
      globalConfigPath: this.globalConfigPath,
    });
    return {
      cwd: registration.worktree.path,
      envDelta: resolveEnvironment({
        ...(config.value.environment === undefined ? {} : { workspace: config.value.environment }),
        context: templateContext(registration),
      }),
    };
  }

  #registration(cwd: string): Registration {
    const absolute = resolve(cwd);
    const worktree = this.store.listWorktrees()
      .filter((candidate) => contains(candidate.path, absolute))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (worktree === undefined) throw new Error('WORKTREE_NOT_REGISTERED');
    const repository = this.store.listRepositories().find(({ id }) => id === worktree.repositoryId);
    if (repository === undefined) throw new Error('REPOSITORY_NOT_REGISTERED');
    const workspace = this.store.listWorkspaces().find(({ id }) => id === repository.workspaceId);
    if (workspace === undefined) throw new Error('WORKSPACE_NOT_REGISTERED');
    return { workspace, repository, worktree };
  }
}

interface Registration {
  workspace: WorkspaceRecord;
  repository: RepositoryRecord;
  worktree: WorktreeRecord;
}

function templateContext({ workspace, repository, worktree }: Registration): TemplateContext {
  const branch = worktree.branch ?? '';
  return {
    workspace: { root: workspace.root, name: workspace.name },
    repo: { root: worktree.path, name: basename(repository.mainRoot) },
    main: { root: repository.mainRoot },
    worktree: { root: worktree.path },
    id: worktree.numericId,
    key: String(worktree.numericId),
    slug: basename(worktree.path),
    branch,
    branchSlug: branch.replace(/[^A-Za-z0-9._-]+/g, '-'),
    env: process.env,
  };
}

function contains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..');
}
