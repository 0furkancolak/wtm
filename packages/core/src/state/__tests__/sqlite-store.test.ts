import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./sqlite-store.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], {
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
});
