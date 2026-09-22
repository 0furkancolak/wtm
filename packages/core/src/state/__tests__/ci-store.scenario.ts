import type { CiRun } from '@wtm/protocol';
import { CiWatchError, type CiWatchStartInput } from '../ci';
import type { SqliteDatabase } from '../database';
import { stateStoreRuntime } from '../runtime';
import { SQLiteStateStore } from '../sqlite-store';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);

function open(): SQLiteStateStore {
  return new SQLiteStateStore(':memory:');
}

function input(overrides: Partial<CiWatchStartInput> = {}): CiWatchStartInput {
  return {
    repositoryId: 'repo-1', worktreeId: 'wt-1', worktreePath: '/w/feat', providerRepo: 'github.com/acme/widgets',
    branch: 'feat', headSha: shaA, pr: null, now: '2026-09-14T12:00:00.000Z', nextPollAt: '2026-09-14T12:00:15.000Z',
    pollIntervalMs: 15_000, maxPending: 20, ...overrides,
  };
}

const run: CiRun = {
  runId: 9, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', url: 'https://example.test/9',
  jobs: [{ jobId: 10, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://example.test/9/10', logSummary: 'boom' }],
};

function reuseSameCommit() {
  const store = open();
  try {
    const { ci } = store;
    const first = ci.start(input());
    const again = ci.start(input({ now: '2026-09-14T12:01:00.000Z' }));
    return {
      firstReused: first.reused,
      firstWatch: {
        state: first.watch.state, headSha: first.watch.headSha, pr: first.watch.pr,
        sawRuns: first.watch.sawRuns, failureStreak: first.watch.failureStreak,
        runs: first.watch.runs, finishedAt: first.watch.finishedAt,
      },
      againIsFirstWatch: JSON.stringify(again.watch) === JSON.stringify(first.watch),
      againReused: again.reused,
    };
  } finally {
    store.close();
  }
}

// Round 11 finding: a later `start()` for the same reused commit dropped a supplied `pr` on the
// floor, since the reuse fast-path returned the stored row unexamined.
function reuseAttachesPrWhenSupplied() {
  const store = open();
  try {
    const { ci } = store;
    const first = ci.start(input());
    const withPr = ci.start(input({ pr: 42, now: '2026-09-14T12:01:00.000Z' }));
    const samePrAgain = ci.start(input({ pr: 42, now: '2026-09-14T12:02:00.000Z' }));
    return {
      firstPr: first.watch.pr,
      withPr: { reused: withPr.reused, watchId: withPr.watch.watchId, pr: withPr.watch.pr },
      sameWatchId: withPr.watch.watchId === first.watch.watchId,
      samePrAgain: { reused: samePrAgain.reused, pr: samePrAgain.watch.pr },
      stored: ci.get(first.watch.watchId)?.pr ?? null,
    };
  } finally {
    store.close();
  }
}

function supersedeOnNewCommit() {
  const store = open();
  try {
    const { ci } = store;
    const old = ci.start(input()).watch;
    const next = ci.start(input({ headSha: shaB, now: '2026-09-14T12:02:00.000Z', nextPollAt: '2026-09-14T12:02:15.000Z' })).watch;
    const oldAfter = ci.get(old.watchId);
    return {
      oldState: oldAfter?.state ?? null,
      oldFinishedAt: oldAfter?.finishedAt ?? null,
      latestIsNext: ci.latestForWorktree('wt-1')?.watchId === next.watchId,
      pendingIsOnlyNext: ci.pending().length === 1 && ci.pending()[0]?.watchId === next.watchId,
    };
  } finally {
    store.close();
  }
}

function refusesBeyondPendingLimit() {
  const store = open();
  try {
    const { ci } = store;
    ci.start(input({ worktreeId: 'wt-1', maxPending: 1 }));
    let firstThrowIsCiWatchError = false;
    try {
      ci.start(input({ worktreeId: 'wt-2', maxPending: 1 }));
    } catch (error) {
      firstThrowIsCiWatchError = error instanceof CiWatchError;
    }
    let secondThrowIsCiWatchError = false;
    let code: unknown = null;
    let context: unknown = null;
    try {
      ci.start(input({ worktreeId: 'wt-2', maxPending: 1 }));
    } catch (error) {
      secondThrowIsCiWatchError = error instanceof CiWatchError;
      if (error instanceof CiWatchError) {
        code = error.code;
        context = error.context;
      }
    }
    return { firstThrowIsCiWatchError, secondThrowIsCiWatchError, code, context };
  } finally {
    store.close();
  }
}

function updatesAndStopsAfterFinish() {
  const store = open();
  try {
    const { ci } = store;
    const { watchId } = ci.start(input()).watch;
    const updated = ci.update(watchId, {
      now: '2026-09-14T12:00:15.000Z', sawRuns: true, runs: [run], pollIntervalMs: 22_500, nextPollAt: '2026-09-14T12:00:37.500Z',
    });
    const finished = ci.update(watchId, { now: '2026-09-14T12:01:00.000Z', state: 'failure' });
    const afterFinishedUpdate = ci.update(watchId, { now: '2026-09-14T12:02:00.000Z', state: 'success' });
    return {
      updatedSawRuns: updated?.sawRuns ?? null,
      updatedRuns: updated?.runs ?? null,
      updatedPollIntervalMs: updated?.pollIntervalMs ?? null,
      finishedState: finished?.state ?? null,
      finishedAt: finished?.finishedAt ?? null,
      afterFinishedUpdateState: afterFinishedUpdate?.state ?? null,
      pendingCount: ci.pending().length,
    };
  } finally {
    store.close();
  }
}

function cancelsDeletesAndPrunes() {
  const store = open();
  try {
    const { ci } = store;
    const { watchId } = ci.start(input()).watch;
    const cancelWt2 = ci.cancelPendingForWorktree('wt-2', '2026-09-14T12:00:01.000Z', 'Stopped.');
    const cancelWt1 = ci.cancelPendingForWorktree('wt-1', '2026-09-14T12:00:01.000Z', 'Stopped.');
    const pruneBefore = ci.prune('2026-09-21T12:00:00.000Z', 604_800_000);
    const pruneAfter = ci.prune('2026-09-21T12:00:02.000Z', 604_800_000);
    ci.start(input({ worktreeId: 'wt-3' }));
    const deletedCount = ci.deleteForWorktree('wt-3');
    const latestWt3 = ci.latestForWorktree('wt-3');
    return {
      cancelWt2IsNull: cancelWt2 === null,
      cancelWt1Matches: cancelWt1 !== null && cancelWt1.watchId === watchId && cancelWt1.state === 'cancelled' && cancelWt1.detail === 'Stopped.',
      pruneBefore,
      pruneAfter,
      deletedCount,
      latestWt3IsNull: latestWt3 === null,
    };
  } finally {
    store.close();
  }
}

function prunesSupersededAfterNewerFinishes() {
  const store = open();
  try {
    const { ci } = store;
    const old = ci.start(input()).watch;
    const next = ci.start(input({ headSha: shaB, now: '2026-09-14T12:02:00.000Z' })).watch;
    const pruneBeforeFinish = ci.prune('2026-09-14T12:03:00.000Z', 604_800_000);
    ci.update(next.watchId, { now: '2026-09-14T12:04:00.000Z', state: 'success' });
    const pruneAfterFinish = ci.prune('2026-09-14T12:05:00.000Z', 604_800_000);
    return { pruneBeforeFinish, pruneAfterFinish, oldIsGoneAfterPrune: ci.get(old.watchId) === null };
  } finally {
    store.close();
  }
}

/** A stored run whose JSON no longer parses is dropped, not thrown, as the store's comment says. */
function dropsRunWithInvalidJson() {
  let database: SqliteDatabase | undefined;
  const store = new SQLiteStateStore(':memory:', {
    databaseFactory: (path, options) => (database = stateStoreRuntime().databaseFactory(path, options)),
  });
  try {
    const { ci } = store;
    const { watchId } = ci.start(input()).watch;
    ci.update(watchId, { now: '2026-09-14T12:00:15.000Z', runs: [run] });
    database!.prepare('INSERT INTO ci_runs (watch_id, position, run_json) VALUES (?, ?, ?)').run(watchId, 1, '{not json');
    return { getRuns: ci.get(watchId)?.runs ?? null, latestRuns: ci.latestForWorktree('wt-1')?.runs ?? null };
  } finally {
    store.close();
  }
}

const scenarios: Record<string, () => unknown> = {
  'drops-run-with-invalid-json': dropsRunWithInvalidJson,
  'reuse-same-commit': reuseSameCommit,
  'reuse-attaches-pr-when-supplied': reuseAttachesPrWhenSupplied,
  'supersede-on-new-commit': supersedeOnNewCommit,
  'refuses-beyond-pending-limit': refusesBeyondPendingLimit,
  'updates-and-stops-after-finish': updatesAndStopsAfterFinish,
  'cancels-deletes-and-prunes': cancelsDeletesAndPrunes,
  'prunes-superseded-after-newer-finishes': prunesSupersededAfterNewerFinishes,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(scenario())}\n`);
