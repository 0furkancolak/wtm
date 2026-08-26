import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteStateStore } from '../sqlite-store';
import type { StateStore } from '../store';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type StateStoreDomainOperation =
  | 'upsertWorkspace'
  | 'upsertRepository'
  | 'reconcileWorktrees'
  | 'allocateEndpoint'
  | 'transaction';
type StateStoreHasExactlyPlannedOperations = Assert<Equal<keyof StateStore, StateStoreDomainOperation>>;

const stateStoreContractIsChecked: StateStoreHasExactlyPlannedOperations = true;
void stateStoreContractIsChecked;

function withDatabase<T>(run: (path: string, open: () => SQLiteStateStore, close: () => void) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'wtm-state-'));
  const path = join(directory, 'state.db');
  const current: { store: SQLiteStateStore | null } = { store: null };
  try {
    return run(
      path,
      () => {
        current.store = new SQLiteStateStore(path);
        return current.store;
      },
      () => {
        current.store?.close();
        current.store = null;
      },
    );
  } finally {
    current.store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function createRepository(store: SQLiteStateStore) {
  const workspace = store.upsertWorkspace({
    name: 'demo',
    root: '/projects/demo',
    scope: 'local',
    configPath: '/projects/demo/wtm.toml',
  });
  return store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: '/projects/demo/repo/.git',
    mainRoot: '/projects/demo/repo',
    remoteIdentity: null,
  });
}

function worktree(path: string, head: string, branch: string) {
  return {
    path,
    head,
    branch,
    detached: false,
    bare: false,
    lockedReason: null,
    prunableReason: null,
  };
}

function stableIdentities() {
  return withDatabase((_, open, close) => {
    const firstStore = open();
    const repository = createRepository(firstStore);
    const initial = firstStore.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo-feature', 'feature-head', 'refs/heads/feature'),
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]);
    close();

    const reopenedStore = open();
    const reconciled = reopenedStore.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'new-main-head', 'refs/heads/main'),
      worktree('/projects/demo/repo-feature', 'feature-head', 'refs/heads/feature'),
    ]);
    return {
      initial: initial.discovered.map(({ path, numericId }) => [path, numericId]),
      reopenedDiscoveredCount: reconciled.discovered.length,
      reopenedUpdated: reconciled.updated.map(({ path, numericId }) => [path, numericId]),
      reopenedMainHead: reconciled.updated[0]?.headOid,
    };
  });
}

function transactionRollback() {
  return withDatabase((path, open, close) => {
    const firstStore = open();
    let rolledBackWorkspaceId = '';
    let abortMessage = '';
    try {
      firstStore.transaction(() => {
        rolledBackWorkspaceId = firstStore.upsertWorkspace({
          name: 'rolled-back',
          root: '/projects/rolled-back',
          scope: 'local',
          configPath: null,
        }).id;
        throw new Error('abort transaction');
      });
    } catch (error) {
      abortMessage = error instanceof Error ? error.message : String(error);
    }
    close();

    const inspector = new Database(path);
    const countRow = inspector
      .prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?')
      .get(rolledBackWorkspaceId) as { count: number };
    inspector.close();

    const reopenedStore = open();
    const persisted = reopenedStore.upsertWorkspace({
      name: 'persisted',
      root: '/projects/rolled-back',
      scope: 'local',
      configPath: null,
    });
    return {
      abortMessage,
      rolledBackWorkspaceCount: countRow.count,
      persistedName: persisted.name,
    };
  });
}

function reconciliationTransitions() {
  return withDatabase((_, open) => {
    const store = open();
    const repository = createRepository(store);
    store.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
      worktree('/projects/demo/repo-old', 'old-head', 'refs/heads/old'),
    ]);

    const lockedMain = {
      ...worktree('/projects/demo/repo', 'new-main-head', 'refs/heads/main'),
      lockedReason: 'administrative lock',
    };
    const result = store.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo-new', 'new-head', 'refs/heads/new'),
      lockedMain,
    ]);
    const repeated = store.reconcileWorktrees(repository.id, [
      lockedMain,
      worktree('/projects/demo/repo-new', 'new-head', 'refs/heads/new'),
    ]);
    const reappeared = store.reconcileWorktrees(repository.id, [
      lockedMain,
      worktree('/projects/demo/repo-new', 'new-head', 'refs/heads/new'),
      worktree('/projects/demo/repo-old', 'revived-head', 'refs/heads/old'),
    ]);

    return {
      discovered: result.discovered.map(({ path, numericId, state }) => [path, numericId, state]),
      updated: result.updated.map(({ path, numericId, headOid, isLocked }) => [
        path,
        numericId,
        headOid,
        isLocked,
      ]),
      orphaned: result.orphaned.map(({ path, numericId, state }) => [path, numericId, state]),
      repeatedOrphanedCount: repeated.orphaned.length,
      reappeared: reappeared.updated
        .filter(({ path }) => path === '/projects/demo/repo-old')
        .map(({ path, numericId, state }) => [path, numericId, state]),
    };
  });
}

function cleanupOwnedReappearance() {
  return withDatabase((path, open, close) => {
    const firstStore = open();
    const repository = createRepository(firstStore);
    const records = [
      worktree('/projects/demo/repo-cleaning', 'cleaning-head', 'refs/heads/cleaning'),
      worktree('/projects/demo/repo-degraded', 'degraded-head', 'refs/heads/degraded'),
      worktree('/projects/demo/repo-orphaned', 'orphaned-head', 'refs/heads/orphaned'),
      worktree('/projects/demo/repo-removed', 'removed-head', 'refs/heads/removed'),
    ];
    firstStore.reconcileWorktrees(repository.id, records);
    close();

    const database = new Database(path);
    const setState = database.prepare('UPDATE worktrees SET state = ? WHERE path = ?');
    setState.run('CLEANING', '/projects/demo/repo-cleaning');
    setState.run('DEGRADED_CLEANUP', '/projects/demo/repo-degraded');
    setState.run('ORPHANED', '/projects/demo/repo-orphaned');
    setState.run('REMOVED', '/projects/demo/repo-removed');
    database.close();

    const reopenedStore = open();
    const result = reopenedStore.reconcileWorktrees(repository.id, records);
    return {
      states: result.updated.map(({ path: worktreePath, state }) => [worktreePath, state]),
    };
  });
}

function endpointAllocation() {
  return withDatabase((path, open, close) => {
    const firstStore = open();
    const repository = createRepository(firstStore);
    const reconciliation = firstStore.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
      worktree('/projects/demo/repo-feature', 'feature-head', 'refs/heads/feature'),
      worktree('/projects/demo/repo-third', 'third-head', 'refs/heads/third'),
    ]);
    const main = reconciliation.discovered[0];
    const feature = reconciliation.discovered[1];
    const third = reconciliation.discovered[2];
    if (main === undefined || feature === undefined || third === undefined) {
      throw new Error('Expected three discovered worktrees');
    }

    const mainLease = firstStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25001,
    });
    const repeated = firstStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25002,
    });
    const fallback = firstStore.allocateEndpoint({
      worktreeId: feature.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25001,
    });
    const otherHost = firstStore.allocateEndpoint({
      worktreeId: feature.id,
      name: 'host-specific',
      protocol: 'tcp',
      host: '0.0.0.0',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25001,
    });
    const udp = firstStore.allocateEndpoint({
      worktreeId: feature.id,
      name: 'udp-service',
      protocol: 'udp',
      host: '127.0.0.1',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25001,
    });
    let exhaustedRangeMessage = '';
    try {
      firstStore.allocateEndpoint({
        worktreeId: third.id,
        name: 'web',
        protocol: 'tcp',
        host: '127.0.0.1',
        portRange: { min: 25000, max: 25001 },
        preferredPort: 25001,
      });
    } catch (error) {
      exhaustedRangeMessage = error instanceof Error ? error.message : String(error);
    }
    close();

    const database = new Database(path);
    let databaseConstraintRejectedAlias = false;
    try {
      database.prepare(`
        INSERT INTO endpoint_leases (
          id, worktree_id, name, protocol, host, port, state, allocated_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'alias-collision',
        third.id,
        'alias-collision',
        'tcp',
        'localhost',
        25001,
        'ACTIVE',
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:00:00.000Z',
      );
    } catch {
      databaseConstraintRejectedAlias = true;
    }
    database.close();

    const reopenedStore = open();
    const reopened = reopenedStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 25000, max: 25002 },
      preferredPort: 25002,
    });
    return {
      mainPort: mainLease.port,
      repeatedLeaseWasStable: repeated.id === mainLease.id && repeated.port === mainLease.port,
      collisionFallbackPort: fallback.port,
      otherHostPort: otherHost.port,
      udpPort: udp.port,
      reopenedLeaseWasStable: reopened.id === mainLease.id && reopened.port === mainLease.port,
      exhaustedRangeMessage,
      databaseConstraintRejectedAlias,
    };
  });
}

function releasedEndpointReactivation() {
  return withDatabase((path, open, close) => {
    const firstStore = open();
    const repository = createRepository(firstStore);
    const worktrees = firstStore.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
      worktree('/projects/demo/repo-feature', 'feature-head', 'refs/heads/feature'),
    ]).discovered;
    const main = worktrees[0];
    const feature = worktrees[1];
    if (main === undefined || feature === undefined) throw new Error('Expected two worktrees');

    const released = firstStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 27000, max: 27000 },
      preferredPort: 27000,
    });
    firstStore.allocateEndpoint({
      worktreeId: feature.id,
      name: 'blocker',
      protocol: 'tcp',
      host: '0.0.0.0',
      portRange: { min: 28001, max: 28001 },
      preferredPort: 28001,
    });
    close();

    const database = new Database(path);
    database.prepare("UPDATE endpoint_leases SET state = 'RELEASED' WHERE id = ?").run(released.id);
    database.close();

    const reopenedStore = open();
    const reactivated = reopenedStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '0.0.0.0',
      portRange: { min: 28000, max: 28001 },
      preferredPort: 28001,
    });
    close();

    const persistedDatabase = new Database(path);
    const persisted = persistedDatabase
      .prepare('SELECT state, port FROM endpoint_leases WHERE id = ?')
      .get(released.id) as { state: string; port: number };
    persistedDatabase.close();
    return {
      keptLeaseIdentity: reactivated.id === released.id,
      state: reactivated.state,
      host: reactivated.host,
      port: reactivated.port,
      persistedState: persisted.state,
      persistedPort: persisted.port,
    };
  });
}

function activeEndpointStability() {
  return withDatabase((path, open, close) => {
    const firstStore = open();
    const repository = createRepository(firstStore);
    const main = firstStore.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]).discovered[0];
    if (main === undefined) throw new Error('Expected discovered worktree');

    const initial = firstStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 32000, max: 32000 },
      preferredPort: 32000,
    });
    const repeated = firstStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 32100, max: 32101 },
      preferredPort: 32101,
    });
    close();

    const reopenedStore = open();
    const reopened = reopenedStore.allocateEndpoint({
      worktreeId: main.id,
      name: 'web',
      protocol: 'tcp',
      host: '127.0.0.1',
      portRange: { min: 32200, max: 32201 },
      preferredPort: 32201,
    });
    close();

    const database = new Database(path);
    const persisted = database
      .prepare('SELECT port FROM endpoint_leases WHERE id = ?')
      .get(initial.id) as { port: number };
    database.close();
    return {
      initialPort: initial.port,
      repeatedKeptIdentity: repeated.id === initial.id,
      repeatedPort: repeated.port,
      reopenedKeptIdentity: reopened.id === initial.id,
      reopenedPort: reopened.port,
      persistedPort: persisted.port,
    };
  });
}

function databasePragmas() {
  return withDatabase((path, open, close) => {
    const store = open();
    let rejectedOrphanRepository = false;
    try {
      store.upsertRepository({
        workspaceId: 'missing-workspace',
        commonGitDir: '/projects/orphan/.git',
        mainRoot: '/projects/orphan',
        remoteIdentity: null,
      });
    } catch {
      rejectedOrphanRepository = true;
    }
    close();

    const database = new Database(path);
    const journalMode = database.pragma('journal_mode', { simple: true });
    database.close();
    return { rejectedOrphanRepository, journalMode };
  });
}

function stateEnumConstraints() {
  return withDatabase((path, open, close) => {
    const store = open();
    const repository = createRepository(store);
    const worktreeRecord = store.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]).discovered[0];
    if (worktreeRecord === undefined) throw new Error('Expected discovered worktree');
    close();

    const database = new Database(path);
    let rejectedWorktreeState = false;
    let rejectedProcessState = false;
    let rejectedResourceState = false;
    try {
      database.prepare('UPDATE worktrees SET state = ? WHERE id = ?').run('INVALID', worktreeRecord.id);
    } catch {
      rejectedWorktreeState = true;
    }
    try {
      database.prepare(`
        INSERT INTO managed_processes (
          id, worktree_id, task_name, pid, pgid, process_start_time, command_fingerprint,
          state, started_at, stopped_at, stdout_path, stderr_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        'invalid-process',
        worktreeRecord.id,
        'dev',
        100,
        100,
        '2026-08-26T00:00:00.000Z',
        'fingerprint',
        'INVALID',
        '2026-08-26T00:00:00.000Z',
        '/tmp/stdout.log',
        '/tmp/stderr.log',
      );
    } catch {
      rejectedProcessState = true;
    }
    try {
      database.prepare(`
        INSERT INTO resources (
          id, owner_type, owner_id, adapter_id, name, resource_type, path, policy,
          retention, state, created_at, last_used_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        'invalid-resource',
        'worktree',
        worktreeRecord.id,
        'docker',
        'database',
        'volume',
        'managed',
        'retain',
        'INVALID',
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:00:00.000Z',
      );
    } catch {
      rejectedResourceState = true;
    }
    database.close();
    return { rejectedWorktreeState, rejectedProcessState, rejectedResourceState };
  });
}

function failedInitializationCleanup() {
  return withDatabase((path, open) => {
    const seed = new Database(path);
    seed.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)');
    seed.close();

    let initializationFailed = false;
    try {
      open();
    } catch {
      initializationFailed = true;
    }
    return {
      initializationFailed,
      walSidecarExistsAfterFailure: existsSync(`${path}-wal`),
    };
  });
}

const scenarios: Record<string, () => unknown> = {
  'stable-identities': stableIdentities,
  'transaction-rollback': transactionRollback,
  'reconciliation-transitions': reconciliationTransitions,
  'cleanup-owned-reappearance': cleanupOwnedReappearance,
  'endpoint-allocation': endpointAllocation,
  'released-endpoint-reactivation': releasedEndpointReactivation,
  'active-endpoint-stability': activeEndpointStability,
  'database-pragmas': databasePragmas,
  'state-enum-constraints': stateEnumConstraints,
  'failed-initialization-cleanup': failedInitializationCleanup,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(scenario())}\n`);
