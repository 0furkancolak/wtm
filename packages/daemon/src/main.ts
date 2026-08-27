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
    this.#recoveryHooks = {
      verifyProcessIdentities: options.recoveryHooks?.verifyProcessIdentities ?? noRecoveryWork,
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
      await this.#reconcileRepositories(this.#snapshot.repositories);
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

  async #reconcileRepositories(repositories: readonly RepositoryRecord[]): Promise<boolean> {
    let topologyChanged = false;
    for (const repository of repositories) {
      const snapshot = await this.#listGitWorktrees(repository.mainRoot);
      const result = this.#stateStore.reconcileWorktrees(repository.id, snapshot);
      if (result.discovered.length > 0 || result.orphaned.length > 0) topologyChanged = true;
      await this.#onReconciled({ repository, result });
    }
    return topologyChanged;
  }

  async #runBatch(batch: ReconcileBatch): Promise<void> {
    if (batch.kinds.includes('watch-error')) this.#watchRefreshPending = true;
    this.#snapshot = this.#loadRegistrations();
    await validateRegistrationRoots(this.#snapshot);
    const topologyChanged = await this.#reconcileRepositories(this.#snapshot.repositories);
    if (batch.kinds.some((kind) => kind === 'config' || kind === 'manifest' || kind === 'fingerprint')) {
      await this.#adapterDiscovery(this.#snapshot);
    }
    if (topologyChanged) this.#watchRefreshPending = true;
    if (this.#watchRefreshPending && !this.#closed) {
      await this.#replaceWatcher();
      this.#watchRefreshPending = false;
    }
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
    for (const resource of [server, watcher]) {
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
    for (const resource of [server, watcher]) {
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
