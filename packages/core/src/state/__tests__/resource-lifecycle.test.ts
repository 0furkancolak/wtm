import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./resource-lifecycle.scenario.ts', import.meta.url));
const finalizationScenarioPath = fileURLToPath(new URL('./resource-finalization.scenario.ts', import.meta.url));

describe('SQLite resource lifecycle ownership', () => {
  test('uses zero-reference leases and a monotonic GC journal', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      leaseWhileReferenced: false,
      referenceReleased: true,
      firstLease: true,
      contendedLease: false,
      mismatchedLease: false,
      referenceWhileLeasedRejected: true,
      nonPositiveLeaseRejected: true,
      expiredLeaseAcquired: true,
      expiredLeaseVisible: false,
      expiredLeaseReacquired: true,
      expiredOldOwnerRenewRejected: true,
      futureDatedReferenceRejected: true,
      evidence: { referenceCount: 0, cleanupLeaseToken: 'lease-1', sandboxGeneration: 'generation-1' },
      wrongOwnerFinalized: false,
      ownerFinalized: true,
      state: 'REMOVED',
      phase: 'finalized',
      sandboxCasRejected: true,
    });
  });

  test('atomically finalizes exact object and journal evidence and replays legacy split state', () => {
    const result = spawnSync('node', ['--import', 'tsx', finalizationScenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      transactionBoundaryFailed: true,
      boundaryObjectState: 'QUARANTINED',
      boundaryJournalPhase: 'deleted',
      atomicReplayFinalized: true,
      atomicObjectState: 'REMOVED',
      atomicJournalPhase: 'finalized',
      oldSplitObjectFinalized: true,
      splitReplayFinalized: true,
      splitJournalPhase: 'finalized',
      upgradedContainerIdentityIsNull: true,
      upgradedReplayFinalized: true,
      upgradedJournalPhase: 'finalized',
    });
  });
});
