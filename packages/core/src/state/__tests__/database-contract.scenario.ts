import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabaseFactory } from '../database';
import { SQLiteStateStore } from '../sqlite-store';

type DriverName = 'better-sqlite' | 'node-sqlite';

async function loadFactory(driver: DriverName): Promise<SqliteDatabaseFactory> {
  if (driver === 'better-sqlite') {
    const { betterSqliteDatabaseFactory } = await import('../better-sqlite-driver');
    return betterSqliteDatabaseFactory;
  }
  const { nodeSqliteDatabaseFactory } = await import('../node-sqlite-driver');
  return nodeSqliteDatabaseFactory;
}

function worktree(path: string) {
  return {
    path,
    head: '0123456789abcdef',
    branch: 'refs/heads/main',
    detached: false,
    bare: false,
    lockedReason: null,
    prunableReason: null,
  };
}

async function run(driver: DriverName): Promise<Record<string, unknown>> {
  const databaseFactory = await loadFactory(driver);
  const directory = mkdtempSync(join(tmpdir(), 'wtm-database-contract-'));
  const databasePath = join(directory, 'state.db');
  let store: SQLiteStateStore | null = null;

  try {
    store = new SQLiteStateStore(databasePath, { databaseFactory });
    const workspace = store.upsertWorkspace({
      name: 'contract',
      root: '/projects/contract',
      scope: 'local',
      configPath: '/projects/contract/wtm.toml',
    });
    const repository = store.upsertRepository({
      workspaceId: workspace.id,
      commonGitDir: '/projects/contract/repository/.git',
      mainRoot: '/projects/contract/repository',
      remoteIdentity: 'ssh://example.invalid/contract.git',
    });
    const reconciliation = store.reconcileWorktrees(repository.id, [
      worktree('/projects/contract/repository'),
    ]);
    const registeredWorktree = reconciliation.discovered[0];
    if (registeredWorktree === undefined) throw new Error('Expected a registered worktree');

    const endpoint = store.allocateEndpoint({
      worktreeId: registeredWorktree.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 45120, max: 45130 },
      preferredPort: 45123,
    });
    const reservationCreatedAt = '2026-08-28T08:00:00.000Z';
    const reservationToken = 'contract-token';
    const reserved = store.reserveManagedProcessStart(
      registeredWorktree.id,
      'dev',
      reservationToken,
      reservationCreatedAt,
      { expiresAt: '2026-08-28T08:05:00.000Z' },
    );
    const createdProcess = store.createManagedProcess({
      worktreeId: registeredWorktree.id,
      taskName: 'dev',
      pid: 4242,
      pgid: 4242,
      processStartTime: '987654',
      commandFingerprint: 'sha256:contract',
      state: 'STARTING',
      startedAt: '2026-08-28T08:00:01.000Z',
      stoppedAt: null,
      stdoutPath: '/logs/dev.stdout.log',
      stderrPath: '/logs/dev.stderr.log',
    }, { reservationToken });
    const runningProcess = store.updateManagedProcess(createdProcess.id, {
      expectedStates: ['STARTING'],
      state: 'RUNNING',
      reservationToken,
    });
    if (runningProcess === null) throw new Error('Expected a running process');

    store.upsertAdapterTrust({
      adapterId: 'contract-adapter',
      canonicalPath: '/adapters/contract',
      sha256: 'a'.repeat(64),
    });
    store.upsertResourceSandbox({
      id: 'sandbox-1',
      root: '/resources/contract',
      generation: 'generation-1',
      dev: 1,
      ino: 2,
      uid: 3,
    });
    store.registerResourceStorageObject({
      id: 'storage-1',
      sandboxId: 'sandbox-1',
      path: '/resources/contract/cache',
      dev: 1,
      ino: 4,
      uid: 3,
      kind: 'directory',
      state: 'READY',
      retention: 'ephemeral',
      owned: true,
      createdAt: '2026-08-28T08:00:02.000Z',
      lastUsedAt: '2026-08-28T08:00:03.000Z',
      lastVerifiedAt: '2026-08-28T08:00:04.000Z',
      logicalBytes: 100,
      allocatedBytes: 128,
    });
    store.addResourceReference({
      id: 'reference-1',
      storageObjectId: 'storage-1',
      ownerType: 'worktree',
      ownerId: registeredWorktree.id,
      resourceName: 'cache',
      createdAt: '2026-08-28T08:00:05.000Z',
    });
    store.registerResourceStorageObject({
      id: 'cleanup-storage',
      sandboxId: 'sandbox-1',
      path: '/resources/contract/stale',
      dev: 1,
      ino: 5,
      uid: 3,
      kind: 'directory',
      state: 'STALE',
      retention: 'ephemeral',
      owned: true,
      createdAt: '2026-08-28T08:00:06.000Z',
      lastUsedAt: '2026-08-28T08:00:06.000Z',
      lastVerifiedAt: '2026-08-28T08:00:06.000Z',
      logicalBytes: 64,
      allocatedBytes: 128,
    });
    const cleanupLeaseAcquired = store.acquireResourceCleanupLease({
      storageObjectId: 'cleanup-storage',
      sandboxId: 'sandbox-1',
      sandboxGeneration: 'generation-1',
      path: '/resources/contract/stale',
      dev: 1,
      ino: 5,
      uid: 3,
      kind: 'directory',
      state: 'STALE',
      retention: 'ephemeral',
    }, 'cleanup-token', 60_000);
    let resourceFinalized: boolean | null = null;
    let resourceFinalizationError: string | null = null;
    try {
      resourceFinalized = store.finalizeResourceCleanup('cleanup-storage', 'cleanup-token');
    } catch (error) {
      resourceFinalizationError = error instanceof Error ? error.message : String(error);
    }

    let rollbackError: string | null = null;
    try {
      const transactionStore = store;
      transactionStore.transaction(() => {
        transactionStore.upsertWorkspace({
          name: 'rolled-back',
          root: '/projects/rolled-back-contract',
          scope: 'local',
          configPath: null,
        });
        throw new Error('contract rollback');
      });
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : String(error);
    }
    // WTM registers a workspace, its repositories, and their worktrees in one outer
    // transaction while `reconcileWorktrees` opens its own, so nesting must behave alike.
    let nestedInnerError: string | null = null;
    const nestedStore = store;
    nestedStore.transaction(() => {
      nestedStore.upsertWorkspace({
        name: 'nested-outer', root: '/projects/nested-outer', scope: 'local', configPath: null,
      });
      nestedStore.transaction(() => {
        nestedStore.upsertWorkspace({
          name: 'nested-committed', root: '/projects/nested-committed', scope: 'local', configPath: null,
        });
      });
      try {
        nestedStore.transaction(() => {
          nestedStore.upsertWorkspace({
            name: 'nested-discarded', root: '/projects/nested-discarded', scope: 'local', configPath: null,
          });
          throw new Error('nested rollback');
        });
      } catch (error) {
        nestedInnerError = error instanceof Error ? error.message : String(error);
      }
    });

    store.close();

    store = new SQLiteStateStore(databasePath, { readonly: true, databaseFactory });
    let readonlyWriteRejected = false;
    try {
      store.upsertWorkspace({
        name: 'forbidden',
        root: '/projects/forbidden',
        scope: 'local',
        configPath: null,
      });
    } catch {
      readonlyWriteRejected = true;
    }

    const roots = store.listWorkspaces().map(({ root }) => root);
    const persistedWorkspace = store.listWorkspaces()[0];
    const persistedRepository = store.listRepositories()[0];
    const persistedWorktree = store.listWorktrees()[0];
    const persistedProcess = store.listManagedProcesses()[0];
    const persistedTrust = store.listAdapterTrust()[0];
    const persistedResources = store.listResourceGcEvidence();
    const persistedResource = persistedResources.find(({ id }) => id === 'storage-1');
    const finalizedResource = persistedResources.find(({ id }) => id === 'cleanup-storage');
    if (
      persistedWorkspace === undefined
      || persistedRepository === undefined
      || persistedWorktree === undefined
      || persistedProcess === undefined
      || persistedTrust === undefined
      || persistedResource === undefined
      || finalizedResource === undefined
    ) throw new Error('Expected all contract records to persist');

    return {
      workspace: [persistedWorkspace.name, persistedWorkspace.root, persistedWorkspace.scope],
      repository: [persistedRepository.mainRoot, persistedRepository.remoteIdentity],
      worktree: [persistedWorktree.path, persistedWorktree.numericId, persistedWorktree.state],
      endpoint: [endpoint.name, endpoint.protocol, endpoint.host, endpoint.port, endpoint.state],
      reservation: [reserved, store.hasManagedProcessStartReservation(persistedWorktree.id, 'dev')],
      process: [
        persistedProcess.taskName,
        persistedProcess.pid,
        persistedProcess.state,
        persistedProcess.cleanupRequired,
      ],
      adapterTrust: [persistedTrust.adapterId, persistedTrust.canonicalPath, persistedTrust.sha256],
      resource: [
        persistedResource.path,
        persistedResource.kind,
        persistedResource.state,
        persistedResource.referenceCount,
        persistedResource.logicalBytes,
        persistedResource.allocatedBytes,
      ],
      resourceFinalization: [
        cleanupLeaseAcquired,
        resourceFinalized,
        resourceFinalizationError,
        finalizedResource.state,
        finalizedResource.cleanupLeaseToken,
      ],
      nested: [
        nestedInnerError,
        roots.includes('/projects/nested-outer'),
        roots.includes('/projects/nested-committed'),
        roots.includes('/projects/nested-discarded'),
      ],
      rollback: [
        rollbackError,
        store.listWorkspaces().every(({ root }) => root !== '/projects/rolled-back-contract'),
      ],
      relationships: {
        repositoryWorkspace: persistedRepository.workspaceId === persistedWorkspace.id,
        worktreeRepository: persistedWorktree.repositoryId === persistedRepository.id,
        processWorktree: persistedProcess.worktreeId === persistedWorktree.id,
      },
      readonlyWriteRejected,
    };
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const driver = process.argv[2];
if (driver !== 'better-sqlite' && driver !== 'node-sqlite') {
  throw new Error(`Unknown database driver: ${driver ?? '<missing>'}`);
}

process.stdout.write(`${JSON.stringify(await run(driver))}\n`);
