import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

// SQLiteStateStore's better-sqlite3 binding crashes Bun's NAPI runtime when constructed directly
// inside a `bun test` process (verified: even a bare `new Database(':memory:')` panics). Every
// other state-store test in this directory runs its store logic in a real `node` child process for
// the same reason (see sqlite-store.test.ts, feature-creations.test.ts); this file follows suit.
const scenarioPath = fileURLToPath(new URL('./ci-store.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath, name]);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const shaA = 'a'.repeat(40);
const run = {
  runId: 9, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', url: 'https://example.test/9',
  jobs: [{ jobId: 10, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://example.test/9/10', logSummary: 'boom' }],
};

describe('CI watch store', () => {
  test('starts a pending watch and reuses it for the same commit', () => {
    expect(runScenario('reuse-same-commit')).toEqual({
      firstReused: false,
      firstWatch: { state: 'pending', headSha: shaA, pr: null, sawRuns: false, failureStreak: 0, runs: [], finishedAt: null },
      againIsFirstWatch: true,
      againReused: true,
    });
  });

  test('a new commit supersedes the pending watch of the same worktree', () => {
    expect(runScenario('supersede-on-new-commit')).toEqual({
      oldState: 'superseded',
      oldFinishedAt: '2026-09-14T12:02:00.000Z',
      latestIsNext: true,
      pendingIsOnlyNext: true,
    });
  });

  test('refuses a watch beyond the pending limit', () => {
    expect(runScenario('refuses-beyond-pending-limit')).toEqual({
      firstThrowIsCiWatchError: true,
      secondThrowIsCiWatchError: true,
      code: 'WTM_CI_UNAVAILABLE',
      context: { pending: 1 },
    });
  });

  test('updates a pending watch, stores runs, and stops updating once finished', () => {
    expect(runScenario('updates-and-stops-after-finish')).toEqual({
      updatedSawRuns: true,
      updatedRuns: [run],
      updatedPollIntervalMs: 22_500,
      finishedState: 'failure',
      finishedAt: '2026-09-14T12:01:00.000Z',
      afterFinishedUpdateState: 'failure',
      pendingCount: 0,
    });
  });

  test('cancels, deletes and prunes', () => {
    expect(runScenario('cancels-deletes-and-prunes')).toEqual({
      cancelWt2IsNull: true,
      cancelWt1Matches: true,
      pruneBefore: 0,
      pruneAfter: 1,
      deletedCount: 1,
      latestWt3IsNull: true,
    });
  });

  test('prunes a superseded watch once a newer watch of its worktree finished', () => {
    expect(runScenario('prunes-superseded-after-newer-finishes')).toEqual({
      pruneBeforeFinish: 0,
      pruneAfterFinish: 1,
      oldIsGoneAfterPrune: true,
    });
  });
});
