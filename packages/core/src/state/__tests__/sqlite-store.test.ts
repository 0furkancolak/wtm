import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./sqlite-store.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], {
    timeout: scenarioTimeoutMs,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('SQLiteStateStore', () => {
  test('lists only persisted daemon registrations in deterministic order', () => {
    expect(runScenario('daemon-registration-queries')).toEqual({
      workspaceRoots: ['/projects/demo', '/projects/zeta'],
      repositoryRoots: ['/projects/demo/repo'],
      worktreePaths: ['/projects/demo/repo', '/projects/demo/repo-linked'],
      allRepositoryRoots: ['/projects/demo/repo', '/projects/zeta/repo'],
    });
  });

  test('keeps worktree numeric IDs stable when snapshot order changes and the database reopens', () => {
    expect(runScenario('stable-identities')).toEqual({
      initial: [
        ['/projects/demo/repo', 1],
        ['/projects/demo/repo-feature', 2],
      ],
      reopenedDiscoveredCount: 0,
      reopenedUpdated: [
        ['/projects/demo/repo', 1],
        ['/projects/demo/repo-feature', 2],
      ],
      reopenedMainHead: 'new-main-head',
    });
  });

  test('rolls back all observable state when a transaction throws', () => {
    expect(runScenario('transaction-rollback')).toEqual({
      abortMessage: 'abort transaction',
      rolledBackWorkspaceCount: 0,
      persistedName: 'persisted',
    });
  });

  test('classifies present and absent worktrees and only reports orphan transitions once', () => {
    expect(runScenario('reconciliation-transitions')).toEqual({
      discovered: [['/projects/demo/repo-new', 3, 'DISCOVERED']],
      updated: [['/projects/demo/repo', 1, 'new-main-head', true]],
      orphaned: [['/projects/demo/repo-old', 2, 'ORPHANED']],
      repeatedOrphanedCount: 0,
      reappeared: [['/projects/demo/repo-old', 2, 'DISCOVERED']],
    });
  });

  test('only auto-revives an orphaned worktree when cleanup-owned paths reappear', () => {
    expect(runScenario('cleanup-owned-reappearance')).toEqual({
      states: [
        ['/projects/demo/repo-cleaning', 'CLEANING'],
        ['/projects/demo/repo-degraded', 'DEGRADED_CLEANUP'],
        ['/projects/demo/repo-orphaned', 'DISCOVERED'],
        ['/projects/demo/repo-removed', 'REMOVED'],
      ],
    });
  });

  test('allocates stable deterministic endpoints with conservative protocol-port uniqueness', () => {
    expect(runScenario('endpoint-allocation')).toEqual({
      mainPort: 25001,
      repeatedLeaseWasStable: true,
      collisionFallbackPort: 25000,
      otherHostPort: 25002,
      udpPort: 25001,
      reopenedLeaseWasStable: true,
      exhaustedRangeMessage: 'No available tcp endpoint on 127.0.0.1 in range 25000-25001',
      databaseConstraintRejectedAlias: true,
    });
  });

  test('reactivates a released endpoint only after selecting an available in-range port', () => {
    expect(runScenario('released-endpoint-reactivation')).toEqual({
      keptLeaseIdentity: true,
      state: 'ACTIVE',
      host: '0.0.0.0',
      port: 28000,
      persistedState: 'ACTIVE',
      persistedPort: 28000,
    });
  });

  test('keeps a compatible active endpoint stable when later range hints exclude its port', () => {
    expect(runScenario('active-endpoint-stability')).toEqual({
      initialPort: 32000,
      repeatedKeptIdentity: true,
      repeatedPort: 32000,
      reopenedKeptIdentity: true,
      reopenedPort: 32000,
      persistedPort: 32000,
    });
  });

  test('enables foreign keys and WAL for a file database', () => {
    expect(runScenario('database-pragmas')).toEqual({
      rejectedOrphanRepository: true,
      journalMode: 'wal',
    });
  });

  test('rejects invalid documented worktree, process, and resource states', () => {
    expect(runScenario('state-enum-constraints')).toEqual({
      rejectedWorktreeState: true,
      rejectedProcessState: true,
      rejectedResourceState: true,
    });
  });

  test('closes the database when migration initialization fails', () => {
    expect(runScenario('failed-initialization-cleanup')).toEqual({
      initializationFailed: true,
      walSidecarExistsAfterFailure: false,
    });
  });

  test('persists exact adapter trust upserts across independent SQLite connections', () => {
    expect(runScenario('adapter-trust-persistence')).toEqual({
      records: [
        ['fake', '/adapters/fake', 'b'.repeat(64)],
        ['other', '/adapters/other', 'c'.repeat(64)],
      ],
      trustedAtIsIso: true,
    });
  });

  test('persists managed process identities and queries active singleton records deterministically', () => {
    expect(runScenario('managed-process-crud')).toEqual({
      createdState: 'STARTING',
      activeIdMatches: true,
      runningState: 'RUNNING',
      stoppedAt: '2026-08-27T09:05:00.000Z',
      activeAfterStop: null,
      orderedStates: ['STOPPED', 'FAILED'],
      rejectedSecondActiveSingleton: true,
      migrationVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
  });

  test('enforces CAS lifecycle transitions and terminal timestamp invariants', () => {
    expect(runScenario('managed-process-lifecycle')).toEqual({
      wrongExpectedStateReturnedNull: true,
      runningState: 'RUNNING',
      stoppingState: 'STOPPING',
      stoppedState: 'STOPPED',
      rejectedRevival: true,
      rejectedTerminalWithoutTimestamp: true,
      rejectedNonterminalTimestamp: true,
    });
  });

  test('serializes process start reservations across independent SQLite connections', () => {
    expect(runScenario('managed-process-reservations')).toEqual({
      firstReserved: true,
      secondBlocked: true,
      wrongTokenDidNotRelease: true,
      reclaimedExpired: true,
      reservationHeldThroughCreate: true,
      runningState: 'RUNNING',
      owningTokenReleased: true,
      cleanupReserved: true,
      cleanupLeaseSurvivedExpiry: true,
      cleanupOwnerTokenPersisted: true,
      recoveryReleasedCleanupLease: true,
    });
  });

  test('migrates the newest v4 cleanup candidate with its reservation ownership', () => {
    expect(runScenario('managed-process-v4-cleanup-upgrade')).toEqual({
      newestFailedCleanupRequired: true,
      newestFailedOwner: 'legacy-token',
      olderFailedCleanupRequired: false,
      unrelatedFailedCleanupRequired: false,
      restartHistoricalCleanupRequired: false,
      restartRunningCleanupRequired: false,
      restartHistoricalCannotRelease: true,
      restartLeaseRetained: true,
      restartExactReclaimed: true,
      stoppedHistoricalCleanupRequired: false,
      tieWinner: 'tie-z',
      tieLoserCleanupRequired: false,
      leaseSurvivedExpiry: true,
      migrationVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
  });

  test('retires a workspace registration with everything that depended on it', () => {
    expect(runScenario('registration-retirement')).toEqual({
      removed: true,
      removingAgain: false,
      remainingWorkspaces: ['kept'],
      remainingRepositories: ['/projects/kept/repo'],
      remainingWorktrees: ['/projects/kept/repo'],
      remainingLeases: 0,
      reclaimable: true,
    });
  });

  test('announces a once-only lifecycle event once per subject, across restarts', () => {
    expect(runScenario('lifecycle-event-claims')).toEqual({
      claimed: true,
      claimedTwice: false,
      otherEvent: true,
      afterRestart: false,
      otherSubject: true,
      withdrawn: true,
      withdrawnTwice: false,
      reclaimedAfterWithdrawal: true,
    });
  });

  test('gives back the ports of a worktree Git no longer reports, and returns them if it comes back', () => {
    expect(runScenario('orphaned-endpoint-release')).toEqual({
      allocatedPort: 4100,
      activeAfterOrphan: 0,
      releasedState: 'RELEASED',
      portAfterReturn: 4100,
      activeAfterReturn: 1,
      // Absence releases, not the transition into it: a lease that survived the pass which
      // orphaned its worktree is otherwise unreachable for the life of the database.
      leakedPort: 4100,
      activeWhileStillAbsent: 1,
      activeAfterLaterPass: 0,
    });
  });
});
