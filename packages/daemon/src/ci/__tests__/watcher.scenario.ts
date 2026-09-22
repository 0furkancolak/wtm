import { SQLiteStateStore, type CiProvider, type CiProviderResult } from '@wtm/core';
import type { CiJob, CiRun, IpcRequest } from '@wtm/protocol';
import { CiWatcher } from '../watcher';

/**
 * `CiWatcher`'s cases, run under plain `node` rather than `bun test`.
 *
 * `SQLiteStateStore` cannot be constructed inside a `bun test` process: better-sqlite3 panics
 * under Bun's own N-API bridge in-process, even though the exact same store works fine in the
 * daemon binary and in every other scenario in this repository. `watcher.test.ts` drives this file
 * through `runScenario`, the way `heavy-job-finalization.test.ts` drives its own `.scenario.ts`.
 * Each case below returns a small snapshot of what its `watcher.test.ts` counterpart asserts; no
 * assertion happens here, so a mismatch fails a normal `expect(...)` in the parent test rather than
 * a bare `process.exit(1)` in this one. An unexpected exception anywhere below is left uncaught on
 * purpose: `runScenario` reports a non-zero exit as a failed scenario.
 */

const sha = 'c'.repeat(40);
const base = Date.parse('2026-09-14T12:00:00.000Z');

function fakeClock() {
  let now = base;
  let sequence = 0;
  let timers: Array<{ id: number; at: number; callback: () => void }> = [];
  return {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => { const id = ++sequence; timers.push({ id, at: now + delayMs, callback }); return id; },
    clearTimeout: (handle: unknown) => { timers = timers.filter(({ id }) => id !== handle); },
    armed: () => timers.length,
    async advance(ms: number, settle: () => Promise<void>) {
      const target = now + ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const next = timers[0];
        if (next === undefined || next.at > target) break;
        timers.shift();
        now = next.at;
        next.callback();
        await settle();
      }
      now = target;
    },
  };
}

type Script = {
  runs: Array<CiProviderResult<CiRun[]>>;
  jobs?: Record<number, CiJob[]>;
  log?: string;
  /** When set, each `failedJobLog` call shifts the next answer off this queue instead of always
   * succeeding with `log` — for cases where an early throttled/transient answer is retried. */
  logAnswers?: Array<CiProviderResult<string>>;
  available?: CiProviderResult<null>;
  /** How many of the first `listRuns` calls throw instead of answering. */
  listRunsThrows?: number;
};

function fakeProvider(script: Script) {
  const calls: string[] = [];
  let throwsLeft = script.listRunsThrows ?? 0;
  const provider: CiProvider = {
    name: 'github',
    checkAvailable: async () => { calls.push('auth'); return script.available ?? { ok: true, value: null }; },
    listRuns: async () => {
      calls.push('runs');
      if (throwsLeft > 0) { throwsLeft -= 1; throw new Error('unexpected provider failure'); }
      return script.runs.length > 1 ? script.runs.shift()! : script.runs[0]!;
    },
    listJobs: async (_repository, runId) => { calls.push(`jobs:${runId}`); return { ok: true, value: script.jobs?.[runId] ?? [] }; },
    failedJobLog: async (_repository, runId, jobId) => {
      calls.push(`log:${runId}:${jobId}`);
      if (script.logAnswers !== undefined) return script.logAnswers.length > 1 ? script.logAnswers.shift()! : script.logAnswers[0]!;
      return { ok: true, value: script.log ?? '##[error]boom' };
    },
    findPr: async () => { calls.push('pr'); return { ok: true, value: null }; },
  };
  return { calls, provider };
}

const run = (status: string, conclusion: string | null): CiRun => ({ runId: 7, workflow: 'CI', event: 'push', status, conclusion, url: 'https://example.test/7', jobs: [] });
const job = (conclusion: string | null): CiJob => ({ jobId: 8, name: 'test', status: conclusion === null ? 'in_progress' : 'completed', conclusion, url: 'https://example.test/7/8' });

function setup(script: Script, remote: string | null = 'git@github.com:acme/widgets.git') {
  const store = new SQLiteStateStore(':memory:');
  const registration = {
    listRepositories: () => [{ id: 'repo-1', workspaceId: 'ws', commonGitDir: '/w/main/.git', mainRoot: '/w/main', remoteIdentity: remote, createdAt: '', lastReconciledAt: null }],
    listWorktrees: () => [{ id: 'wt-1', repositoryId: 'repo-1', numericId: 1, path: '/w/feat', branch: 'feat', headOid: sha, isMain: false, isLocked: false, state: 'READY' as const, createdAt: '', lastSeenAt: '', lastRuntimeAt: null }],
  };
  const clock = fakeClock();
  const { calls, provider } = fakeProvider(script);
  const errors: string[] = [];
  const watcher = new CiWatcher({ store: store.ci, registration, provider, clock, onError: (error) => errors.push(String(error)) });
  const request = (command: string, args: unknown): IpcRequest => ({ protocol: { major: 1, minor: 0 }, id: 'r', command, arguments: args });
  const watch = async (headSha: string = sha) => await watcher.handle(request('ci.watch', { cwd: '/w/feat/src', branch: 'feat', headSha }));
  const settle = async () => await watcher.idle();
  return { store, clock, calls, errors, watcher, request, watch, settle };
}

/** Starts a pending watch of another commit on `wt-1` directly in the store, for `watch()` to supersede. */
function startOlderWatch(t: ReturnType<typeof setup>) {
  return t.store.ci.start({
    repositoryId: 'repo-1', worktreeId: 'wt-1', worktreePath: '/w/feat', providerRepo: 'github.com/acme/widgets',
    branch: 'feat', headSha: 'd'.repeat(40), pr: null, now: new Date(base).toISOString(), nextPollAt: new Date(base + 15_000).toISOString(),
    pollIntervalMs: 15_000, maxPending: 20,
  }).watch;
}

/** Final fix F3: a two-segment host other than github.com that gh is not logged in to has no CI provider. */
async function nonGithubHostUnauthenticated() {
  const gitlab = setup({ runs: [], available: { ok: false, failure: { kind: 'unavailable', reason: 'unauthenticated', detail: 'not logged in' } } }, 'git@gitlab.com:acme/widgets.git');
  try {
    const refused = await gitlab.watch();
    return { refused, pending: gitlab.store.ci.pending().length, calls: gitlab.calls };
  } finally {
    gitlab.store.close();
  }
}

/** Final fix F5: an unexpected poll error pushes that watch out by its interval instead of re-arming at 0 ms. */
async function unexpectedErrorDoesNotRetryImmediately() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }], jobs: { 7: [job(null)] }, listRunsThrows: 1 });
  try {
    await t.watch();
    await t.clock.advance(15_000, t.settle);
    const runsAfterError = t.calls.filter((call) => call === 'runs').length;
    const errorsAfterError = t.errors.length;
    const nextPollAtAfterError = t.store.ci.latestForWorktree('wt-1')?.nextPollAt ?? null;
    await t.clock.advance(15_000, t.settle);
    const runsLater = t.calls.filter((call) => call === 'runs').length;
    return { runsAfterError, errorsAfterError, nextPollAtAfterError, runsLater };
  } finally {
    t.store.close();
  }
}

/** Final fix F6: with no runs yet, the interval still grows ×1.5; `no_runs` still lands 3 minutes from start. */
async function noRunsPollingGrows() {
  const t = setup({ runs: [{ ok: true, value: [] }] });
  try {
    await t.watch();
    await t.clock.advance(15_000, t.settle);
    const afterFirst = t.store.ci.latestForWorktree('wt-1')?.pollIntervalMs ?? null;
    await t.clock.advance(22_500, t.settle);
    const afterSecond = t.store.ci.latestForWorktree('wt-1')?.pollIntervalMs ?? null;
    await t.clock.advance(180_000 - 37_500, t.settle);
    const finished = t.store.ci.latestForWorktree('wt-1');
    return {
      afterFirst, afterSecond, state: finished?.state ?? null, finishedAt: finished?.finishedAt ?? null,
      listRunsCalls: t.calls.filter((call) => call === 'runs').length,
    };
  } finally {
    t.store.close();
  }
}

/** Final fix F9: a watch ending `unavailable` or cancelled prunes the superseded watch it replaced. */
async function finishingPrunesSuperseded() {
  const gone = setup({ runs: [{ ok: false, failure: { kind: 'unavailable', reason: 'not-found', detail: 'HTTP 404' } }] });
  const stopped = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }] });
  try {
    const goneOld = startOlderWatch(gone);
    await gone.watch();
    await gone.clock.advance(15_000 * 3, gone.settle);
    const unavailableState = gone.store.ci.latestForWorktree('wt-1')?.state ?? null;
    const supersededGoneAfterUnavailable = gone.store.ci.get(goneOld.watchId) === null;

    const stoppedOld = startOlderWatch(stopped);
    await stopped.watch();
    await stopped.watcher.handle(stopped.request('ci.unwatch', { cwd: '/w/feat' }));
    const supersededGoneAfterCancel = stopped.store.ci.get(stoppedOld.watchId) === null;
    return { unavailableState, supersededGoneAfterUnavailable, supersededGoneAfterCancel };
  } finally {
    gone.store.close();
    stopped.store.close();
  }
}

/** Final fix F10: watching the same head again reuses the pending watch without spending an auth probe. */
async function rewatchSameHeadSkipsAuthProbe() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }] });
  try {
    const first = await t.watch();
    const callsAfterFirst = [...t.calls];
    const second = await t.watch();
    return { first, second, callsAfterFirst, callsAfterSecond: [...t.calls] };
  } finally {
    t.store.close();
  }
}

// Round 11 finding: `--pr <n>` supplied against a commit a pending watch already reuses used to
// be dropped silently, since the reuse fast-path returned the stored watch unchanged.
async function rewatchAttachesPrToReusedWatch() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }] });
  try {
    const first = await t.watch();
    const second = await t.watcher.handle(t.request('ci.watch', { cwd: '/w/feat/src', branch: 'feat', headSha: sha, pr: 42 }));
    const stored = t.store.ci.latestForWorktree('wt-1');
    // A later watch of the same commit and the same PR is still a no-op reuse.
    const third = await t.watcher.handle(t.request('ci.watch', { cwd: '/w/feat/src', branch: 'feat', headSha: sha, pr: 42 }));
    return { first, second, third, stored };
  } finally {
    t.store.close();
  }
}

async function acceptPollAndFinish() {
  const t = setup({
    runs: [{ ok: true, value: [run('in_progress', null)] }, { ok: true, value: [run('completed', 'failure')] }],
    jobs: { 7: [job('failure')] },
    log: 'x\ty\t2026-09-14T12:00:00.0000000Z ##[error]boom',
  });
  try {
    const accepted = await t.watch();
    const armedAfterAccept = t.clock.armed();
    await t.clock.advance(15_000, t.settle);
    const afterFirstPoll = t.store.ci.latestForWorktree('wt-1');
    await t.clock.advance(15_000, t.settle);
    const finished = t.store.ci.latestForWorktree('wt-1');
    const armedAfterFinish = t.clock.armed();
    return { accepted, armedAfterAccept, afterFirstPoll, finished, calls: t.calls, armedAfterFinish };
  } finally {
    t.store.close();
  }
}

async function successNeverDownloadsLogs() {
  const t = setup({ runs: [{ ok: true, value: [run('completed', 'success')] }], jobs: { 7: [job('success')] } });
  try {
    await t.watch();
    await t.clock.advance(15_000, t.settle);
    const state = t.store.ci.latestForWorktree('wt-1')?.state ?? null;
    const downloadedLogs = t.calls.some((call) => call.startsWith('log:'));
    return { state, downloadedLogs };
  } finally {
    t.store.close();
  }
}

async function backsOffAndResets() {
  const t = setup({ runs: [{ ok: true, value: [run('queued', null)] }, { ok: true, value: [run('queued', null)] }, { ok: true, value: [run('in_progress', null)] }] });
  try {
    await t.watch();
    await t.clock.advance(15_000, t.settle);
    await t.clock.advance(15_000, t.settle);
    const afterTwo = t.store.ci.latestForWorktree('wt-1')?.pollIntervalMs ?? null;
    await t.clock.advance(22_500, t.settle);
    const afterReset = t.store.ci.latestForWorktree('wt-1')?.pollIntervalMs ?? null;
    return { afterTwo, afterReset };
  } finally {
    t.store.close();
  }
}

async function noRunsAndTimedOut() {
  const none = setup({ runs: [{ ok: true, value: [] }] });
  const slow = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }] });
  try {
    await none.watch();
    await none.clock.advance(180_000, none.settle);
    const noRuns = none.store.ci.latestForWorktree('wt-1');

    await slow.watch();
    // Polls land on the backoff grid, so run one maximum interval past the deadline.
    await slow.clock.advance(7_200_000 + 120_000, slow.settle);
    const timedOut = slow.store.ci.latestForWorktree('wt-1');
    return { noRuns, timedOut };
  } finally {
    none.store.close();
    slow.store.close();
  }
}

async function throttlingAndUnavailable() {
  const throttled = setup({ runs: [{ ok: false, failure: { kind: 'throttled', detail: 'rate limit' } }] });
  const gone = setup({ runs: [{ ok: false, failure: { kind: 'unavailable', reason: 'not-found', detail: 'HTTP 404' } }] });
  try {
    await throttled.watch();
    await throttled.clock.advance(15_000, throttled.settle);
    const throttledRecord = throttled.store.ci.latestForWorktree('wt-1');

    await gone.watch();
    await gone.clock.advance(15_000 * 3, gone.settle);
    const unavailableRecord = gone.store.ci.latestForWorktree('wt-1');
    return { throttledRecord, unavailableRecord };
  } finally {
    throttled.store.close();
    gone.store.close();
  }
}

async function refusals() {
  const unsupportedRemote = setup({ runs: [] }, 'https://gitlab.com/g/s/p.git');
  const missingGh = setup({ runs: [], available: { ok: false, failure: { kind: 'unavailable', reason: 'missing', detail: 'no gh' } } });
  const unauthenticated = setup({ runs: [], available: { ok: false, failure: { kind: 'unavailable', reason: 'unauthenticated', detail: 'login' } } });
  const forbidden = setup({ runs: [], available: { ok: false, failure: { kind: 'unavailable', reason: 'forbidden', detail: 'HTTP 403: Resource not accessible by integration' } } });
  try {
    return {
      unsupportedRemote: await unsupportedRemote.watch(),
      missingGh: await missingGh.watch(),
      unauthenticated: await unauthenticated.watch(),
      forbidden: await forbidden.watch(),
    };
  } finally {
    unsupportedRemote.store.close();
    missingGh.store.close();
    unauthenticated.store.close();
    forbidden.store.close();
  }
}

async function unwatchAndUnregisteredCwd() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }] });
  try {
    await t.watch();
    const firstUnwatch = await t.watcher.handle(t.request('ci.unwatch', { cwd: '/w/feat' }));
    const armedAfterUnwatch = t.clock.armed();
    const secondUnwatch = await t.watcher.handle(t.request('ci.unwatch', { cwd: '/w/feat' }));
    const elsewhereWatch = await t.watcher.handle(t.request('ci.watch', { cwd: '/elsewhere', branch: null, headSha: sha }));
    return { firstUnwatch, armedAfterUnwatch, secondUnwatch, elsewhereWatch };
  } finally {
    t.store.close();
  }
}

async function restartResumesAndTimesOutExpired() {
  const t = setup({ runs: [{ ok: true, value: [run('completed', 'success')] }] });
  try {
    await t.watch();
    await t.watcher.close();
    const later = new CiWatcher({
      store: t.store.ci,
      registration: { listRepositories: () => [], listWorktrees: () => [] },
      provider: fakeProvider({ runs: [{ ok: true, value: [run('completed', 'success')] }] }).provider,
      clock: t.clock,
    });
    await later.start();
    const armedAfterResume = t.clock.armed();
    await t.clock.advance(15_000, async () => await later.idle());
    const resumedState = t.store.ci.latestForWorktree('wt-1')?.state ?? null;

    const expired = setup({ runs: [{ ok: true, value: [] }] });
    try {
      await expired.watch();
      await expired.watcher.close();
      await expired.clock.advance(7_200_000, async () => {});
      const resumed = new CiWatcher({
        store: expired.store.ci,
        registration: { listRepositories: () => [], listWorktrees: () => [] },
        provider: fakeProvider({ runs: [] }).provider,
        clock: expired.clock,
      });
      await resumed.start();
      const expiredState = expired.store.ci.latestForWorktree('wt-1')?.state ?? null;
      const armedAfterExpiredResume = expired.clock.armed();
      return { armedAfterResume, resumedState, expiredState, armedAfterExpiredResume };
    } finally {
      expired.store.close();
    }
  } finally {
    t.store.close();
  }
}

async function budgetCapsCallsPerMinute() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }], jobs: { 7: [job(null)] } });
  try {
    // 20 worktrees each with a pending watch would need 40 calls in the first tick.
    for (let index = 0; index < 20; index += 1) {
      t.store.ci.start({
        repositoryId: 'repo-1', worktreeId: `wt-x${index}`, worktreePath: `/x/${index}`, providerRepo: 'github.com/acme/widgets',
        branch: null, headSha: sha, pr: null, now: new Date(base).toISOString(), nextPollAt: new Date(base + 15_000).toISOString(),
        pollIntervalMs: 15_000, maxPending: 20,
      });
    }
    await t.watcher.start();
    await t.clock.advance(15_000, t.settle);
    return { callsLength: t.calls.length };
  } finally {
    t.store.close();
  }
}

/**
 * Fix round 1, finding 1: the `checkAvailable` probe `ci.watch` runs before accepting a watch
 * spends from the same 30-calls-per-minute budget every poll draws from. A watch is started
 * first (consuming one 'auth' call), 20 more watches are ticked to exhaustion the same way
 * `budgetCapsCallsPerMinute` does, and then the same commit is watched again while the window is
 * still full: the probe must be skipped (no new provider call at all) and the watch still
 * accepted, reused rather than refused, the same outcome a throttled answer would produce.
 */
async function budgetFullSkipsAuthProbeOnRewatch() {
  const t = setup({ runs: [{ ok: true, value: [run('in_progress', null)] }], jobs: { 7: [job(null)] } });
  try {
    await t.watch();
    // wt-1 (above) plus 19 more is exactly the 20-pending-watch ceiling — the ceiling, not the
    // per-minute call budget, is what must not be hit here.
    for (let index = 0; index < 19; index += 1) {
      t.store.ci.start({
        repositoryId: 'repo-1', worktreeId: `wt-x${index}`, worktreePath: `/x/${index}`, providerRepo: 'github.com/acme/widgets',
        branch: null, headSha: sha, pr: null, now: new Date(base).toISOString(), nextPollAt: new Date(base + 15_000).toISOString(),
        pollIntervalMs: 15_000, maxPending: 20,
      });
    }
    await t.clock.advance(15_000, t.settle);
    const callsAfterTick = t.calls.length;
    // Another commit, so the probe is not skipped merely because a pending watch is reused (F10).
    const rewatch = await t.watch('e'.repeat(40));
    const callsAfterRewatch = t.calls.length;
    return { callsAfterTick, rewatch, callsAfterRewatch };
  } finally {
    t.store.close();
  }
}

/**
 * Fix round 1, finding 2: a throttled or transient `failedJobLog` answer must delay the watch and
 * retry the same job, not settle for a placeholder summary. The first attempt is throttled; the
 * second succeeds with the real log.
 */
async function failedJobLogRetriesAfterThrottleThenSucceeds() {
  const t = setup({
    runs: [{ ok: true, value: [run('completed', 'failure')] }],
    jobs: { 7: [job('failure')] },
    logAnswers: [
      { ok: false, failure: { kind: 'throttled', detail: 'rate limit' } },
      { ok: true, value: 'x\ty\t2026-09-14T12:00:00.0000000Z ##[error]boom' },
    ],
  });
  try {
    await t.watch();
    await t.clock.advance(15_000, t.settle);
    const afterThrottle = t.store.ci.latestForWorktree('wt-1');
    const logCallsAfterThrottle = t.calls.filter((call) => call.startsWith('log:')).length;
    // throttledDelayMs(15_000) = 30_000: the watch's own pollIntervalMs doubled.
    await t.clock.advance(30_000, t.settle);
    const finished = t.store.ci.latestForWorktree('wt-1');
    const logCallsFinal = t.calls.filter((call) => call.startsWith('log:')).length;
    return { afterThrottle, logCallsAfterThrottle, finished, logCallsFinal };
  } finally {
    t.store.close();
  }
}

/**
 * Fix round 1, finding 3: a tick polls from a snapshot taken at its start, so a watch cancelled
 * while an earlier watch's `gh` call for the same tick is still in flight must not be polled once
 * its own turn comes up. `wt-1`'s `listRuns` answer cancels `wt-2` as a side effect, modeling a
 * concurrent `ci.unwatch` landing mid-tick; `wt-2` is due in the same tick and sequenced after
 * `wt-1`, so it would be polled next were it not for the tick's re-read.
 */
async function tickSkipsWatchCancelledMidTick() {
  const store = new SQLiteStateStore(':memory:');
  const registration = {
    listRepositories: () => [{ id: 'repo-1', workspaceId: 'ws', commonGitDir: '/w/main/.git', mainRoot: '/w/main', remoteIdentity: 'git@github.com:acme/widgets.git', createdAt: '', lastReconciledAt: null }],
    listWorktrees: () => [{ id: 'wt-1', repositoryId: 'repo-1', numericId: 1, path: '/w/feat', branch: 'feat', headOid: sha, isMain: false, isLocked: false, state: 'READY' as const, createdAt: '', lastSeenAt: '', lastRuntimeAt: null }],
  };
  const clock = fakeClock();
  const calls: string[] = [];
  const provider: CiProvider = {
    name: 'github',
    checkAvailable: async () => { calls.push('auth'); return { ok: true, value: null }; },
    listRuns: async () => {
      calls.push('runs');
      // The exact race the tick's re-read guards against: `wt-2` is cancelled while `wt-1`'s own
      // `listRuns` call for this same tick is still in flight.
      store.ci.cancelPendingForWorktree('wt-2', new Date(clock.now()).toISOString(), 'cancelled mid tick');
      return { ok: true, value: [run('completed', 'success')] };
    },
    listJobs: async (_repository, runId) => { calls.push(`jobs:${runId}`); return { ok: true, value: [job('success')] }; },
    failedJobLog: async (_repository, runId, jobId) => { calls.push(`log:${runId}:${jobId}`); return { ok: true, value: '##[error]boom' }; },
    findPr: async () => { calls.push('pr'); return { ok: true, value: null }; },
  };
  const watcher = new CiWatcher({ store: store.ci, registration, provider, clock });
  const request = (command: string, args: unknown): IpcRequest => ({ protocol: { major: 1, minor: 0 }, id: 'r', command, arguments: args });
  try {
    // wt-1 first, so it gets the lower sequence number and is polled before wt-2 in the tick
    // `pending()` orders by (nextPollAt, sequence) — both are due at the same instant.
    await watcher.handle(request('ci.watch', { cwd: '/w/feat/src', branch: 'feat', headSha: sha }));
    store.ci.start({
      repositoryId: 'repo-1', worktreeId: 'wt-2', worktreePath: '/w/other', providerRepo: 'github.com/acme/widgets',
      branch: null, headSha: sha, pr: null, now: new Date(base).toISOString(), nextPollAt: new Date(base + 15_000).toISOString(),
      pollIntervalMs: 15_000, maxPending: 20,
    });
    await clock.advance(15_000, async () => await watcher.idle());
    const wt2 = store.ci.latestForWorktree('wt-2');
    return { calls, wt2State: wt2?.state ?? null };
  } finally {
    store.close();
  }
}

const result = {
  acceptPollAndFinish: await acceptPollAndFinish(),
  successNeverDownloadsLogs: await successNeverDownloadsLogs(),
  backsOffAndResets: await backsOffAndResets(),
  noRunsAndTimedOut: await noRunsAndTimedOut(),
  throttlingAndUnavailable: await throttlingAndUnavailable(),
  refusals: await refusals(),
  unwatchAndUnregisteredCwd: await unwatchAndUnregisteredCwd(),
  restartResumesAndTimesOutExpired: await restartResumesAndTimesOutExpired(),
  budgetCapsCallsPerMinute: await budgetCapsCallsPerMinute(),
  budgetFullSkipsAuthProbeOnRewatch: await budgetFullSkipsAuthProbeOnRewatch(),
  failedJobLogRetriesAfterThrottleThenSucceeds: await failedJobLogRetriesAfterThrottleThenSucceeds(),
  tickSkipsWatchCancelledMidTick: await tickSkipsWatchCancelledMidTick(),
  nonGithubHostUnauthenticated: await nonGithubHostUnauthenticated(),
  unexpectedErrorDoesNotRetryImmediately: await unexpectedErrorDoesNotRetryImmediately(),
  noRunsPollingGrows: await noRunsPollingGrows(),
  finishingPrunesSuperseded: await finishingPrunesSuperseded(),
  rewatchSameHeadSkipsAuthProbe: await rewatchSameHeadSkipsAuthProbe(),
  rewatchAttachesPrToReusedWatch: await rewatchAttachesPrToReusedWatch(),
};

console.log(JSON.stringify(result));
