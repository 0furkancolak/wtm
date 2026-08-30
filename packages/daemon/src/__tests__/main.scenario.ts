import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  SQLiteStateStore,
  readGitRepositoryIdentity,
  retriedWorktreeListTimeoutMs,
  type DaemonStateStore,
  type GitWorktreeRecord,
} from '../../../core/src/index';
import { DaemonClient } from '../../../cli/src/client';
import { WtmDaemon } from '../main';
import type { ReconcileSignal } from '../reconciler-queue';

const run = promisify(execFile);

function snapshot(path: string): GitWorktreeRecord[] {
  return [{
    path,
    head: '0123456789abcdef',
    branch: 'refs/heads/main',
    detached: false,
    bare: false,
    lockedReason: null,
    prunableReason: null,
  }];
}

async function withDirectory<T>(prefix: string, action: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function startupOrder() {
  return await withDirectory('wtm-startup-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const events: string[] = [];
    const baseStore = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = baseStore.upsertWorkspace({
        name: 'startup', root, scope: 'local', configPath: join(root, 'wtm.toml'),
      });
      const repository = baseStore.upsertRepository({
        workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null,
      });
      const stateStore = new Proxy(baseStore, {
        get(target, property) {
          if (property === 'listWorkspaces') return () => {
            events.push('load-workspaces');
            return target.listWorkspaces();
          };
          if (property === 'listRepositories') return (...args: [string?]) => {
            events.push('load-repositories');
            return target.listRepositories(...args);
          };
          if (property === 'reconcileWorktrees') return (id: string, records: GitWorktreeRecord[]) => {
            events.push('reconcile-state');
            return target.reconcileWorktrees(id, records);
          };
          const value = target[property as keyof SQLiteStateStore] as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as DaemonStateStore;
      const daemon = new WtmDaemon({
        stateStore,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => { events.push('git-snapshot'); return snapshot(repositoryRoot); },
        recoveryHooks: {
          verifyProcessIdentities: async () => { events.push('verify-processes'); },
          verifyEndpointLeases: async () => { events.push('verify-endpoints'); },
          scheduleCleanupRetries: async () => { events.push('schedule-cleanup'); },
        },
        watcherFactory: () => ({
          start: async () => { events.push('watcher-start'); },
          close: async () => { events.push('watcher-close'); },
          whenIdle: async () => {},
        }),
        serverFactory: () => ({
          start: async () => { events.push('socket-start'); },
          close: async () => { events.push('socket-close'); },
        }),
      });
      await daemon.start();
      const persistedMainWorktree = baseStore.listWorktrees(repository.id).some(({ path }) => path === repositoryRoot);
      await daemon.close();
      return { events: events.slice(0, 9), persistedMainWorktree };
    } finally {
      baseStore.close();
    }
  });
}

async function startupFailure() {
  return await withDirectory('wtm-startup-failure-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'failure', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      const events: string[] = [];
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => snapshot(repositoryRoot),
        watcherFactory: () => ({
          start: async () => { events.push('watcher-start'); },
          close: async () => { events.push('watcher-close'); },
          whenIdle: async () => {},
        }),
        serverFactory: () => ({
          start: async () => { events.push('socket-start'); throw new Error('bind failed'); },
          close: async () => { events.push('socket-close'); },
        }),
      });
      let error = '';
      try {
        await daemon.start();
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return { error, events };
    } finally {
      store.close();
    }
  });
}

async function sourceFilter() {
  return await withDirectory('wtm-source-filter-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'filter', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      const listeners = new Map<string, (eventType: string, filename: string | Buffer | null) => void>();
      let adapterDiscoveries = 0;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => snapshot(repositoryRoot),
        adapterDiscovery: async () => { adapterDiscoveries += 1; },
        watchFactory: (watchRoot, _options, listener) => {
          listeners.set(watchRoot, listener);
          return {
            close: () => listeners.delete(watchRoot),
            onError: () => () => {},
          };
        },
        fingerprint: async () => 'initial',
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      listeners.get(repositoryRoot)?.('change', 'src/index.ts');
      await daemon.flush();
      const afterSourceEdit = adapterDiscoveries;
      listeners.get(repositoryRoot)?.('change', 'package.json');
      await daemon.flush();
      const afterManifestEdit = adapterDiscoveries;
      await daemon.close();
      return { afterSourceEdit, afterManifestEdit };
    } finally {
      store.close();
    }
  });
}

async function flushFixedPoint() {
  return await withDirectory('wtm-flush-fixed-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'flush', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      let reconciliations = 0;
      let idleCalls = 0;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => { reconciliations += 1; return snapshot(repositoryRoot); },
        watcherFactory: (_registrations, schedule) => ({
          start: async () => {},
          close: async () => {},
          whenIdle: async () => {
            idleCalls += 1;
            if (idleCalls === 2) schedule({ root, kind: 'git-topology' });
          },
        }),
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      await daemon.flush();
      const reconciliationsAfterFlush = reconciliations;
      await daemon.close();
      return { reconciliationsAfterFlush };
    } finally {
      store.close();
    }
  });
}

async function explicitReconcileFailure() {
  return await withDirectory('wtm-reconcile-failure-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const socketPath = join(root, 'wtmd.sock');
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'failure', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      let fail = false;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath,
        listGitWorktrees: async () => {
          if (fail) throw new Error('secret reconciliation detail');
          return snapshot(repositoryRoot);
        },
        watcherFactory: () => ({ start: async () => {}, close: async () => {}, whenIdle: async () => {} }),
      });
      await daemon.start();
      const client = new DaemonClient({ socketPath, requestTimeoutMs: 2_000 });
      try {
        await client.start();
        fail = true;
        const response = await client.request('reconcile');
        return {
          ok: response.ok,
          code: response.errors[0]?.code,
          message: response.errors[0]?.message,
        };
      } finally {
        await client.close();
        await daemon.close();
      }
    } finally {
      store.close();
    }
  });
}

async function watchErrorRefresh() {
  return await withDirectory('wtm-watch-refresh-', async (root) => {
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      store.upsertWorkspace({ name: 'refresh', root, scope: 'local', configPath: null });
      let schedule!: (signal: ReconcileSignal) => void;
      let starts = 0;
      let closes = 0;
      let adapterDiscoveries = 0;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        adapterDiscovery: async () => { adapterDiscoveries += 1; },
        watcherFactory: (_registrations, capturedSchedule) => {
          schedule = capturedSchedule;
          return {
            start: async () => { starts += 1; },
            close: async () => { closes += 1; },
            whenIdle: async () => {},
          };
        },
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      schedule({ root, kind: 'watch-error' });
      await daemon.flush();
      const result = {
        startsAfterFlush: starts,
        closesAfterFlush: closes,
        adapterDiscoveries,
      };
      await daemon.close();
      return result;
    } finally {
      store.close();
    }
  });
}

async function watchErrorMissingRoot() {
  return await withDirectory('wtm-watch-missing-', async (root) => {
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    const socketPath = join(root, 'wtmd.sock');
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      store.upsertWorkspace({ name: 'missing', root: workspaceRoot, scope: 'local', configPath: null });
      let schedule!: (signal: ReconcileSignal) => void;
      let starts = 0;
      let closes = 0;
      let adapterDiscoveries = 0;
      const reported: string[] = [];
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath,
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        adapterDiscovery: async () => { adapterDiscoveries += 1; },
        watcherFactory: (_registrations, capturedSchedule) => {
          schedule = capturedSchedule;
          return {
            start: async () => { starts += 1; },
            close: async () => { closes += 1; },
            whenIdle: async () => {},
          };
        },
      });
      await daemon.start();
      const client = new DaemonClient({ socketPath, requestTimeoutMs: 2_000 });
      try {
        await client.start();
        schedule({ root: workspaceRoot, kind: 'watch-error' });
        await rm(workspaceRoot, { recursive: true, force: true });
        await daemon.flush();
        await mkdir(workspaceRoot);
        const response = await client.request('reconcile');
        return {
          reportedWhileMissing: reported.map((message) => message.split(':')[0] ?? ''),
          reconcileOk: response.ok,
          startsAfterRecovery: starts,
          closesAfterRecovery: closes,
          adapterDiscoveries,
        };
      } finally {
        await client.close();
        await daemon.close();
      }
    } finally {
      store.close();
    }
  });
}

async function shutdownDuringStart() {
  return await withDirectory('wtm-shutdown-start-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'race', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      const events: string[] = [];
      let enterWatcher!: () => void;
      let releaseWatcher!: () => void;
      const watcherEntered = new Promise<void>((resolve) => { enterWatcher = resolve; });
      const watcherReleased = new Promise<void>((resolve) => { releaseWatcher = resolve; });
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => snapshot(repositoryRoot),
        watcherFactory: () => ({
          start: async () => {
            events.push('watcher-start');
            enterWatcher();
            await watcherReleased;
          },
          close: async () => { events.push('watcher-close'); },
          whenIdle: async () => {},
        }),
        serverFactory: () => ({
          start: async () => { events.push('socket-start'); },
          close: async () => { events.push('socket-close'); },
        }),
      });
      let startError = '';
      const starting = daemon.start().catch((error: unknown) => {
        startError = error instanceof Error ? error.message : String(error);
      });
      await watcherEntered;
      const closing = daemon.close();
      releaseWatcher();
      await Promise.all([starting, closing]);
      return { events, startError };
    } finally {
      store.close();
    }
  });
}

async function closeFailureCleanup() {
  return await withDirectory('wtm-close-failure-', async (root) => {
    const repositoryRoot = join(root, 'repo');
    const commonGitDir = join(repositoryRoot, '.git');
    await mkdir(commonGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'close', root, scope: 'local', configPath: null });
      store.upsertRepository({ workspaceId: workspace.id, commonGitDir, mainRoot: repositoryRoot, remoteIdentity: null });
      const events: string[] = [];
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async () => snapshot(repositoryRoot),
        watcherFactory: () => ({
          start: async () => {},
          close: async () => { events.push('watcher-close'); },
          whenIdle: async () => {},
        }),
        serverFactory: () => ({
          start: async () => {},
          close: async () => { events.push('socket-close'); throw new Error('server close failed'); },
        }),
      });
      await daemon.start();
      let closeError = '';
      try {
        await daemon.close();
      } catch (error) {
        closeError = error instanceof Error ? error.message : String(error);
      }
      return { closeError, events };
    } finally {
      store.close();
    }
  });
}

async function rawWorktree() {
  return await withDirectory('wtm-raw-worktree-', async (root) => {
    const repositoryRoot = join(root, 'workspace', 'repo');
    const outsideWorktree = join(root, 'outside', 'raw-linked');
    await mkdir(repositoryRoot, { recursive: true });
    await run('git', ['init', '-b', 'main', repositoryRoot]);
    await writeFile(join(repositoryRoot, 'README.md'), 'seed\n');
    await run('git', ['-C', repositoryRoot, 'add', '.']);
    await run('git', [
      '-C', repositoryRoot, '-c', 'user.name=WTM Test', '-c', 'user.email=wtm@example.invalid',
      'commit', '-m', 'seed',
    ]);
    const identity = await readGitRepositoryIdentity(repositoryRoot);
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({
        name: 'raw', root: join(root, 'workspace'), scope: 'local', configPath: null,
      });
      const repository = store.upsertRepository({
        workspaceId: workspace.id,
        commonGitDir: identity.commonGitDir,
        mainRoot: identity.topLevel,
        remoteIdentity: null,
      });
      let resolveDetected!: () => void;
      const detected = new Promise<void>((resolve) => { resolveDetected = resolve; });
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        onReconciled: () => {
          if (store.listWorktrees(repository.id).some(({ path }) => path === outsideWorktree)) resolveDetected();
        },
      });
      await daemon.start();
      await mkdir(join(root, 'outside'), { recursive: true });
      await run('git', ['-C', repositoryRoot, 'worktree', 'add', '-b', 'feature/raw', outsideWorktree]);
      await withTimeout(detected, 5_000, 'raw worktree reconciliation timed out');
      const worktrees = store.listWorktrees(repository.id);
      await daemon.close();
      return {
        detectedOutside: worktrees.some(({ path }) => path === outsideWorktree),
        worktreeCount: worktrees.length,
      };
    } finally {
      store.close();
    }
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function unreadableRepositorySurvives() {
  return await withDirectory('wtm-unreadable-', async (root) => {
    const healthyRoot = join(root, 'healthy');
    const blockedRoot = join(root, 'blocked');
    for (const path of [healthyRoot, blockedRoot]) await mkdir(join(path, '.git'), { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({
        name: 'unreadable', root, scope: 'local', configPath: join(root, 'wtm.toml'),
      });
      for (const path of [blockedRoot, healthyRoot]) {
        store.upsertRepository({
          workspaceId: workspace.id,
          commonGitDir: join(path, '.git'),
          mainRoot: path,
          remoteIdentity: null,
        });
      }
      const reported: string[] = [];
      let socketOpened = false;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        listGitWorktrees: async (path: string) => {
          if (path === blockedRoot) throw new Error('Timed out after 200ms');
          return snapshot(path);
        },
        recoveryHooks: {
          verifyProcessIdentities: async () => {},
          verifyEndpointLeases: async () => {},
          scheduleCleanupRetries: async () => {},
        },
        watcherFactory: () => ({
          start: async () => {}, close: async () => {}, whenIdle: async () => {},
        }),
        serverFactory: () => ({
          start: async () => { socketOpened = true; }, close: async () => {},
        }),
      });
      await daemon.start();
      const healthyRegistered = store.listWorktrees().some(({ path }) => path === healthyRoot);
      await daemon.close();
      return { socketOpened, healthyRegistered, reported };
    } finally {
      store.close();
    }
  });
}

/**
 * When not one repository can be read, the daemon says so once, in the terms the condition
 * actually has — not once per repository, in the terms of the git command that stalled.
 *
 * The terms matter as much as the count. Directories that open perfectly well while git
 * overruns its bound describe a filesystem answering slowly, and must not be reported as one
 * WTM is forbidden to read: acting on that reading means granting a background agent every
 * file on the disk.
 */
async function unreadableWorkspaceIsNamed() {
  return await withDirectory('wtm-unreadable-workspace-', async (root) => {
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'blocked', root, scope: 'local', configPath: null });
      for (const name of ['one', 'two']) {
        const path = join(root, name);
        await mkdir(join(path, '.git'), { recursive: true });
        store.upsertRepository({
          workspaceId: workspace.id, commonGitDir: join(path, '.git'), mainRoot: path, remoteIdentity: null,
        });
      }
      const reported: string[] = [];
      const bounds: (number | undefined)[] = [];
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        listGitWorktrees: async (_root, timeoutMs) => {
          bounds.push(timeoutMs);
          const failure = new Error('Git worktree list failed (signal SIGTERM): Timed out after 5000ms');
          Object.assign(failure, { timedOut: true });
          throw failure;
        },
        recoveryHooks: {
          verifyProcessIdentities: async () => {},
          verifyEndpointLeases: async () => {},
          scheduleCleanupRetries: async () => {},
        },
        watcherFactory: () => ({ start: async () => {}, close: async () => {}, whenIdle: async () => {} }),
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      await daemon.close();
      return {
        named: reported.filter((message) => message.startsWith('None of ')),
        timeouts: reported.filter((message) => message.includes('Timed out')).length,
        attempts: bounds.length,
        retriedWithAWiderBound: bounds.filter((bound) => bound === retriedWorktreeListTimeoutMs).length,
      };
    } finally {
      store.close();
    }
  });
}

/**
 * The reason the retry exists: a pass that reads eight repositories at once off a volume still
 * spinning up can overrun a bound every one of them clears a moment later. Believing the first
 * reading discards the whole pass and leaves every registered repository stale.
 */
async function coldVolumeReadRecovers() {
  return await withDirectory('wtm-cold-volume-', async (root) => {
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'cold', root, scope: 'local', configPath: null });
      const path = join(root, 'repo');
      await mkdir(join(path, '.git'), { recursive: true });
      store.upsertRepository({
        workspaceId: workspace.id, commonGitDir: join(path, '.git'), mainRoot: path, remoteIdentity: null,
      });
      const reported: string[] = [];
      let attempts = 0;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        listGitWorktrees: async () => {
          attempts += 1;
          if (attempts === 1) {
            const failure = new Error('Git worktree list failed (signal SIGTERM): Timed out after 5000ms');
            Object.assign(failure, { timedOut: true });
            throw failure;
          }
          return snapshot(path);
        },
        recoveryHooks: {
          verifyProcessIdentities: async () => {},
          verifyEndpointLeases: async () => {},
          scheduleCleanupRetries: async () => {},
        },
        watcherFactory: () => ({ start: async () => {}, close: async () => {}, whenIdle: async () => {} }),
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      await daemon.close();
      return {
        attempts,
        reported,
        worktrees: store.listWorktrees().map(({ path: worktreePath, state }) => [worktreePath, state]),
      };
    } finally {
      store.close();
    }
  });
}

/**
 * The one reading that does justify naming the privacy grant: a directory that exists and
 * still refuses to open. Nothing short of that evidence should send anyone to Full Disk Access.
 */
async function refusedDirectoryNamesTheGrant() {
  return await withDirectory('wtm-refused-directory-', async (root) => {
    const store = new SQLiteStateStore(join(root, 'state.db'));
    const path = join(root, 'refused');
    try {
      const workspace = store.upsertWorkspace({ name: 'refused', root, scope: 'local', configPath: null });
      await mkdir(join(path, '.git'), { recursive: true });
      store.upsertRepository({
        workspaceId: workspace.id, commonGitDir: join(path, '.git'), mainRoot: path, remoteIdentity: null,
      });
      // Traversable but not listable: `.git` is still reachable, so the repository is taken as
      // present and the read is what fails — the shape a privacy denial actually presents.
      await chmod(path, 0o111);
      const reported: string[] = [];
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        listGitWorktrees: async () => {
          const failure = new Error('Git worktree list failed (signal SIGTERM): Timed out after 5000ms');
          Object.assign(failure, { timedOut: true });
          throw failure;
        },
        recoveryHooks: {
          verifyProcessIdentities: async () => {},
          verifyEndpointLeases: async () => {},
          scheduleCleanupRetries: async () => {},
        },
        watcherFactory: () => ({ start: async () => {}, close: async () => {}, whenIdle: async () => {} }),
        serverFactory: () => ({ start: async () => {}, close: async () => {} }),
      });
      await daemon.start();
      await daemon.close();
      return { named: reported.filter((message) => message.startsWith('None of ')) };
    } finally {
      await chmod(path, 0o700).catch(() => {});
      store.close();
    }
  });
}

/**
 * A registered repository whose directory has been deleted must not stop the daemon: launchd
 * restarts a service that exits, so refusing to start turned one removed directory into a
 * permanent restart loop that denied every other workspace a daemon.
 */
async function deletedRepositorySurvives() {
  return await withDirectory('wtm-deleted-repository-', async (root) => {
    const healthyRoot = join(root, 'healthy');
    const healthyGitDir = join(healthyRoot, '.git');
    await mkdir(healthyGitDir, { recursive: true });
    const store = new SQLiteStateStore(join(root, 'state.db'));
    try {
      const workspace = store.upsertWorkspace({ name: 'deleted', root, scope: 'local', configPath: null });
      store.upsertRepository({
        workspaceId: workspace.id,
        commonGitDir: join(root, 'gone', '.git'),
        mainRoot: join(root, 'gone'),
        remoteIdentity: null,
      });
      const healthy = store.upsertRepository({
        workspaceId: workspace.id, commonGitDir: healthyGitDir, mainRoot: healthyRoot, remoteIdentity: null,
      });
      const reported: string[] = [];
      let socketOpened = false;
      const daemon = new WtmDaemon({
        stateStore: store,
        socketPath: join(root, 'wtmd.sock'),
        listGitWorktrees: async (repositoryRoot) => snapshot(repositoryRoot),
        onError: (error) => { reported.push(error instanceof Error ? error.message : String(error)); },
        watcherFactory: () => ({ start: async () => {}, close: async () => {}, whenIdle: async () => {} }),
        serverFactory: () => ({ start: async () => { socketOpened = true; }, close: async () => {} }),
      });
      await daemon.start();
      await daemon.close();
      return {
        socketOpened,
        healthyRegistered: store.listWorktrees(healthy.id).some(({ path }) => path === healthyRoot),
        reported: reported.map((message) => message.replace(root, '<root>')),
      };
    } finally {
      store.close();
    }
  });
}

const scenarios: Record<string, () => Promise<unknown>> = {
  'startup-order': startupOrder,
  'startup-failure': startupFailure,
  'source-filter': sourceFilter,
  'raw-worktree': rawWorktree,
  'shutdown-during-start': shutdownDuringStart,
  'close-failure-cleanup': closeFailureCleanup,
  'flush-fixed-point': flushFixedPoint,
  'explicit-reconcile-failure': explicitReconcileFailure,
  'watch-error-refresh': watchErrorRefresh,
  'watch-error-missing-root': watchErrorMissingRoot,
  'unreadable-repository': unreadableRepositorySurvives,
  'deleted-repository': deletedRepositorySurvives,
  'unreadable-workspace': unreadableWorkspaceIsNamed,
  'cold-volume-read': coldVolumeReadRecovers,
  'refused-directory': refusedDirectoryNamesTheGrant,
};

const name = process.argv[2];
const scenario = name === undefined ? undefined : scenarios[name];
if (scenario === undefined) throw new Error(`Unknown scenario: ${name ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(await scenario())}\n`);
