import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  | 'upsertAdapterTrust'
  | 'listAdapterTrust'
  | 'listEndpointLeases'
  | 'createManagedProcess'
  | 'getManagedProcess'
  | 'updateManagedProcess'
  | 'listManagedProcesses'
  | 'findActiveManagedProcess'
  | 'reserveManagedProcessStart'
  | 'releaseManagedProcessStart'
  | 'releaseExpiredManagedProcessStart'
  | 'releaseExpiredManagedProcessReplacement'
  | 'hasManagedProcessStartReservation'
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

function daemonRegistrationQueries() {
  return withDatabase((_, open) => {
    const store = open();
    const secondWorkspace = store.upsertWorkspace({
      name: 'zeta',
      root: '/projects/zeta',
      scope: 'global-only',
      configPath: null,
    });
    const firstRepository = createRepository(store);
    store.upsertRepository({
      workspaceId: secondWorkspace.id,
      commonGitDir: '/projects/zeta/repo/.git',
      mainRoot: '/projects/zeta/repo',
      remoteIdentity: 'ssh://example.invalid/zeta.git',
    });
    store.reconcileWorktrees(firstRepository.id, [
      worktree('/projects/demo/repo-linked', 'linked-head', 'refs/heads/linked'),
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]);

    const firstWorkspace = store.listWorkspaces().find(({ root }) => root === '/projects/demo');
    if (firstWorkspace === undefined) throw new Error('Expected demo workspace');
    return {
      workspaceRoots: store.listWorkspaces().map(({ root }) => root),
      repositoryRoots: store.listRepositories(firstWorkspace.id).map(({ mainRoot }) => mainRoot),
      worktreePaths: store.listWorktrees(firstRepository.id).map(({ path }) => path),
      allRepositoryRoots: store.listRepositories().map(({ mainRoot }) => mainRoot),
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

function managedProcessCrud() {
  return withDatabase((path, open, close) => {
    const store = open();
    const repository = createRepository(store);
    const worktreeRecord = store.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]).discovered[0];
    if (worktreeRecord === undefined) throw new Error('Expected discovered worktree');

    const created = store.createManagedProcess({
      worktreeId: worktreeRecord.id,
      taskName: 'dev',
      pid: 41001,
      pgid: 41001,
      processStartTime: '123456789',
      commandFingerprint: 'sha256:first',
      state: 'STARTING',
      startedAt: '2026-08-27T09:00:00.000Z',
      stoppedAt: null,
      stdoutPath: '/logs/dev.stdout.log',
      stderrPath: '/logs/dev.stderr.log',
    });
    const active = store.findActiveManagedProcess(worktreeRecord.id, 'dev');
    const running = store.updateManagedProcess(created.id, { expectedStates: ['STARTING'], state: 'RUNNING' });

    let rejectedSecondActiveSingleton = false;
    try {
      store.createManagedProcess({
        worktreeId: worktreeRecord.id,
        taskName: 'dev',
        pid: 41002,
        pgid: 41002,
        processStartTime: '123456790',
        commandFingerprint: 'sha256:second',
        state: 'STARTING',
        startedAt: '2026-08-27T09:01:00.000Z',
        stoppedAt: null,
        stdoutPath: '/logs/dev-2.stdout.log',
        stderrPath: '/logs/dev-2.stderr.log',
      });
    } catch {
      rejectedSecondActiveSingleton = true;
    }

    const stopped = store.updateManagedProcess(created.id, {
      expectedStates: ['RUNNING'],
      state: 'STOPPED',
      stoppedAt: '2026-08-27T09:05:00.000Z',
    });
    store.createManagedProcess({
      worktreeId: worktreeRecord.id,
      taskName: 'dev',
      pid: 41003,
      pgid: 41003,
      processStartTime: '123456791',
      commandFingerprint: 'sha256:third',
      state: 'FAILED',
      startedAt: '2026-08-27T09:06:00.000Z',
      stoppedAt: '2026-08-27T09:06:01.000Z',
      stdoutPath: '/logs/dev-3.stdout.log',
      stderrPath: '/logs/dev-3.stderr.log',
    });
    close();

    const database = new Database(path);
    const migrationVersions = (database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>).map(({ version }) => version);
    database.close();

    const reopened = open();
    return {
      createdState: created.state,
      activeIdMatches: active?.id === created.id,
      runningState: running?.state,
      stoppedAt: stopped?.stoppedAt,
      activeAfterStop: reopened.findActiveManagedProcess(worktreeRecord.id, 'dev'),
      orderedStates: reopened.listManagedProcesses({
        worktreeId: worktreeRecord.id,
        taskName: 'dev',
      }).map(({ state }) => state),
      rejectedSecondActiveSingleton,
      migrationVersions,
    };
  });
}

function managedProcessLifecycle() {
  return withDatabase((_, open) => {
    const store = open();
    const repository = createRepository(store);
    const worktreeRecord = store.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]).discovered[0];
    if (worktreeRecord === undefined) throw new Error('Expected discovered worktree');
    const base = {
      worktreeId: worktreeRecord.id,
      taskName: 'lifecycle',
      pid: 42001,
      pgid: 42001,
      processStartTime: 'start',
      commandFingerprint: 'fingerprint',
      state: 'STARTING' as const,
      startedAt: '2026-08-27T10:00:00.000Z',
      stoppedAt: null,
      stdoutPath: '/logs/lifecycle.stdout.log',
      stderrPath: '/logs/lifecycle.stderr.log',
    };
    const created = store.createManagedProcess(base);
    const wrongExpected = store.updateManagedProcess(created.id, {
      expectedStates: ['RUNNING'],
      state: 'STOPPING',
    });
    const running = store.updateManagedProcess(created.id, {
      expectedStates: ['STARTING'],
      state: 'RUNNING',
    });
    if (running === null) throw new Error('Expected RUNNING transition');
    const stopping = store.updateManagedProcess(created.id, {
      expectedStates: ['RUNNING'],
      state: 'STOPPING',
    });
    if (stopping === null) throw new Error('Expected STOPPING transition');

    let rejectedTerminalWithoutTimestamp = false;
    try {
      store.updateManagedProcess(created.id, {
        expectedStates: ['STOPPING'],
        state: 'STOPPED',
      });
    } catch {
      rejectedTerminalWithoutTimestamp = true;
    }
    const stopped = store.updateManagedProcess(created.id, {
      expectedStates: ['STOPPING'],
      state: 'STOPPED',
      stoppedAt: '2026-08-27T10:01:00.000Z',
    });
    if (stopped === null) throw new Error('Expected STOPPED transition');
    let rejectedRevival = false;
    try {
      store.updateManagedProcess(created.id, {
        expectedStates: ['STOPPED'],
        state: 'RUNNING',
      });
    } catch {
      rejectedRevival = true;
    }
    let rejectedNonterminalTimestamp = false;
    try {
      store.createManagedProcess({
        ...base,
        taskName: 'invalid-time',
        stoppedAt: '2026-08-27T10:02:00.000Z',
      });
    } catch {
      rejectedNonterminalTimestamp = true;
    }
    return {
      wrongExpectedStateReturnedNull: wrongExpected === null,
      runningState: running.state,
      stoppingState: stopping.state,
      stoppedState: stopped.state,
      rejectedRevival,
      rejectedTerminalWithoutTimestamp,
      rejectedNonterminalTimestamp,
    };
  });
}

function managedProcessReservations() {
  return withDatabase((path, open, close) => {
    const first = open();
    const repository = createRepository(first);
    const worktreeRecord = first.reconcileWorktrees(repository.id, [
      worktree('/projects/demo/repo', 'main-head', 'refs/heads/main'),
    ]).discovered[0];
    if (worktreeRecord === undefined) throw new Error('Expected discovered worktree');
    close();
    const firstStore = new SQLiteStateStore(path);
    const secondStore = new SQLiteStateStore(path);
    try {
      const firstReserved = firstStore.reserveManagedProcessStart(
        worktreeRecord.id,
        'dev',
        'token-1',
        '2026-08-27T11:00:00.000Z',
        { expiresAt: '2026-08-27T11:00:10.000Z' } as never,
      );
      const secondBlocked = !secondStore.reserveManagedProcessStart(
        worktreeRecord.id,
        'dev',
        'token-2',
        '2026-08-27T11:00:01.000Z',
        { expiresAt: '2026-08-27T11:00:11.000Z' } as never,
      );
      const wrongTokenDidNotRelease = !secondStore.releaseManagedProcessStart(
        worktreeRecord.id,
        'dev',
        'token-2',
      );
      const reclaimedExpired = secondStore.reserveManagedProcessStart(
        worktreeRecord.id,
        'dev',
        'token-2',
        '2026-08-27T11:00:11.000Z',
        { expiresAt: '2026-08-27T11:00:21.000Z' } as never,
      );
      const created = secondStore.createManagedProcess({
        worktreeId: worktreeRecord.id,
        taskName: 'dev',
        pid: 43001,
        pgid: 43001,
        processStartTime: 'start',
        commandFingerprint: 'fingerprint',
        state: 'STARTING',
        startedAt: '2026-08-27T11:00:12.000Z',
        stoppedAt: null,
        stdoutPath: '/logs/reserved.stdout.log',
        stderrPath: '/logs/reserved.stderr.log',
      }, { reservationToken: 'token-2' });
      const reservationHeldThroughCreate = !firstStore.reserveManagedProcessStart(
        worktreeRecord.id,
        'dev',
        'token-3',
        '2026-08-27T11:00:13.000Z',
        { expiresAt: '2026-08-27T11:00:23.000Z' } as never,
      );
      const running = secondStore.updateManagedProcess(created.id, {
        expectedStates: ['STARTING'],
        state: 'RUNNING',
        reservationToken: 'token-2',
      } as never);
      const owningTokenReleased = secondStore.releaseManagedProcessStart(worktreeRecord.id, 'dev', 'token-2');
      const cleanupReserved = secondStore.reserveManagedProcessStart(
        worktreeRecord.id,
        'cleanup',
        'cleanup-token',
        '2026-08-27T11:01:00.000Z',
        { expiresAt: '2026-08-27T11:01:01.000Z' },
      );
      const cleanupRecord = secondStore.createManagedProcess({
        worktreeId: worktreeRecord.id,
        taskName: 'cleanup',
        pid: 43002,
        pgid: 43002,
        processStartTime: 'cleanup-start',
        commandFingerprint: 'cleanup-fingerprint',
        state: 'FAILED',
        startedAt: '2026-08-27T11:01:00.000Z',
        stoppedAt: '2026-08-27T11:01:00.000Z',
        stdoutPath: '/logs/cleanup.stdout.log',
        stderrPath: '/logs/cleanup.stderr.log',
        cleanupRequired: true,
        cleanupOwnerToken: 'cleanup-token',
      }, { reservationToken: 'cleanup-token' });
      const cleanupLeaseSurvivedExpiry = !secondStore.releaseExpiredManagedProcessStart(
        worktreeRecord.id,
        'cleanup',
        '2026-08-27T11:02:00.000Z',
      );
      const recoveryReleasedCleanupLease = secondStore.releaseManagedProcessStart(
        worktreeRecord.id, 'cleanup', 'cleanup-token',
      );
      return {
        firstReserved,
        secondBlocked,
        wrongTokenDidNotRelease,
        reclaimedExpired,
        reservationHeldThroughCreate,
        runningState: running?.state,
        owningTokenReleased,
        cleanupReserved,
        cleanupLeaseSurvivedExpiry,
        cleanupOwnerTokenPersisted: cleanupRecord.cleanupOwnerToken === 'cleanup-token',
        recoveryReleasedCleanupLease,
      };
    } finally {
      firstStore.close();
      secondStore.close();
    }
  });
}

function managedProcessV4CleanupUpgrade() {
  return withDatabase((path) => {
    const database = new Database(path);
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const [version, file] of [
      [1, '001-initial.sql'], [2, '002-managed-process-indexes.sql'],
      [3, '003-managed-process-reservations.sql'], [4, '004-managed-process-reservation-leases.sql'],
    ] as const) {
      database.exec(String(requireMigration(file)));
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(version, '2026-08-27T00:00:00.000Z');
    }
    database.prepare(`INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('ws', 'demo', '/demo', 'local', null, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
    database.prepare(`INSERT INTO repositories VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('repo', 'ws', '/demo/.git', '/demo', null, '2026-08-27T00:00:00.000Z', null);
    database.prepare(`INSERT INTO worktrees VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('wt', 'repo', 1, '/demo', 'main', 'head', 1, 0, 'READY', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z', null);
    const insert = database.prepare(`INSERT INTO managed_processes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('old', 'wt', 'dev', 40001, 40001, 'old-start', 'old-fp', 'FAILED', '2026-08-27T00:00:01.000Z', '2026-08-27T00:00:02.000Z', '/logs/old.out', '/logs/old.err');
    insert.run('live', 'wt', 'dev', 40002, 40002, 'live-start', 'live-fp', 'FAILED', '2026-08-27T00:00:03.000Z', '2026-08-27T00:00:04.000Z', '/logs/live.out', '/logs/live.err');
    insert.run('other', 'wt', 'other', 40003, 40003, 'other-start', 'other-fp', 'FAILED', '2026-08-27T00:00:05.000Z', '2026-08-27T00:00:06.000Z', '/logs/other.out', '/logs/other.err');
    insert.run('restart-failed', 'wt', 'restart', 40004, 40004, 'failed-start', 'failed-fp', 'FAILED', '2026-08-27T00:00:01.000Z', '2026-08-27T00:00:02.000Z', '/logs/restart-old.out', '/logs/restart-old.err');
    insert.run('restart-running', 'wt', 'restart', 40005, 40005, 'running-start', 'running-fp', 'RUNNING', '2026-08-27T00:00:03.000Z', null, '/logs/restart.out', '/logs/restart.err');
    insert.run('stopped-failed', 'wt', 'stopped', 40006, 40006, 'stopped-failed-start', 'stopped-failed-fp', 'FAILED', '2026-08-27T00:00:01.000Z', '2026-08-27T00:00:02.000Z', '/logs/stopped-old.out', '/logs/stopped-old.err');
    insert.run('stopped-latest', 'wt', 'stopped', 40007, 40007, 'stopped-start', 'stopped-fp', 'STOPPED', '2026-08-27T00:00:03.000Z', '2026-08-27T00:00:04.000Z', '/logs/stopped.out', '/logs/stopped.err');
    insert.run('tie-a', 'wt', 'tie', 40008, 40008, 'tie-a-start', 'tie-a-fp', 'FAILED', '2026-08-27T00:00:05.000Z', '2026-08-27T00:00:06.000Z', '/logs/tie-a.out', '/logs/tie-a.err');
    insert.run('tie-z', 'wt', 'tie', 40009, 40009, 'tie-z-start', 'tie-z-fp', 'FAILED', '2026-08-27T00:00:05.000Z', '2026-08-27T00:00:06.000Z', '/logs/tie-z.out', '/logs/tie-z.err');
    database.prepare(`INSERT INTO managed_process_start_reservations VALUES (?, ?, ?, ?, ?, ?)`)
      .run('wt', 'dev', 'legacy-token', '2026-08-27T00:00:03.000Z', '2026-08-27T00:00:10.000Z', null);
    database.prepare(`INSERT INTO managed_process_start_reservations VALUES (?, ?, ?, ?, ?, ?)`)
      .run('wt', 'restart', 'restart-token', '2026-08-27T00:00:03.000Z', '2026-08-27T00:00:10.000Z', 'restart-running');
    database.prepare(`INSERT INTO managed_process_start_reservations VALUES (?, ?, ?, ?, ?, ?)`)
      .run('wt', 'stopped', 'stopped-token', '2026-08-27T00:00:03.000Z', '2026-08-27T00:00:10.000Z', null);
    database.prepare(`INSERT INTO managed_process_start_reservations VALUES (?, ?, ?, ?, ?, ?)`)
      .run('wt', 'tie', 'tie-token', '2026-08-27T00:00:05.000Z', '2026-08-27T00:00:10.000Z', null);
    database.close();

    const store = new SQLiteStateStore(path);
    const records = store.listManagedProcesses();
    const result = {
      newestFailedCleanupRequired: records.find(({ id }) => id === 'live')?.cleanupRequired,
      newestFailedOwner: records.find(({ id }) => id === 'live')?.cleanupOwnerToken,
      olderFailedCleanupRequired: records.find(({ id }) => id === 'old')?.cleanupRequired,
      unrelatedFailedCleanupRequired: records.find(({ id }) => id === 'other')?.cleanupRequired,
      restartHistoricalCleanupRequired: records.find(({ id }) => id === 'restart-failed')?.cleanupRequired,
      restartRunningCleanupRequired: records.find(({ id }) => id === 'restart-running')?.cleanupRequired,
      restartHistoricalCannotRelease: !store.releaseExpiredManagedProcessReplacement(
        records.find(({ id }) => id === 'restart-failed')!,
        '2026-08-27T01:00:00.000Z',
      ),
      restartLeaseRetained: store.hasManagedProcessStartReservation('wt', 'restart'),
      restartExactReclaimed: store.releaseExpiredManagedProcessReplacement(
        records.find(({ id }) => id === 'restart-running')!,
        '2026-08-27T01:00:00.000Z',
      ),
      stoppedHistoricalCleanupRequired: records.find(({ id }) => id === 'stopped-failed')?.cleanupRequired,
      tieWinner: records.find(({ cleanupOwnerToken }) => cleanupOwnerToken === 'tie-token')?.id,
      tieLoserCleanupRequired: records.find(({ id }) => id === 'tie-a')?.cleanupRequired,
      leaseSurvivedExpiry: !store.releaseExpiredManagedProcessStart('wt', 'dev', '2026-08-27T01:00:00.000Z'),
      migrationVersions: [] as number[],
    };
    store.close();
    const migrated = new Database(path);
    result.migrationVersions = (migrated.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(({ version }) => version);
    migrated.close();
    return result;
  });
}

function adapterTrustPersistence() {
  return withDatabase((path, open, close) => {
    const first = open();
    const second = new SQLiteStateStore(path);
    try {
      first.upsertAdapterTrust({
        adapterId: 'fake', canonicalPath: '/adapters/fake', sha256: 'a'.repeat(64),
      });
      second.upsertAdapterTrust({
        adapterId: 'other', canonicalPath: '/adapters/other', sha256: 'c'.repeat(64),
      });
      const renewed = second.upsertAdapterTrust({
        adapterId: 'fake', canonicalPath: '/adapters/fake', sha256: 'b'.repeat(64),
      });
      return {
        records: first.listAdapterTrust().map(({ adapterId, canonicalPath, sha256 }) => [adapterId, canonicalPath, sha256]),
        trustedAtIsIso: !Number.isNaN(Date.parse(renewed.trustedAt)),
      };
    } finally {
      second.close();
      close();
    }
  });
}

function requireMigration(file: string): string {
  return readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
}

const scenarios: Record<string, () => unknown> = {
  'daemon-registration-queries': daemonRegistrationQueries,
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
  'managed-process-crud': managedProcessCrud,
  'managed-process-lifecycle': managedProcessLifecycle,
  'managed-process-reservations': managedProcessReservations,
  'managed-process-v4-cleanup-upgrade': managedProcessV4CleanupUpgrade,
  'adapter-trust-persistence': adapterTrustPersistence,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(scenario())}\n`);
