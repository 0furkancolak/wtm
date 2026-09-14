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

type Script = { runs: Array<CiProviderResult<CiRun[]>>; jobs?: Record<number, CiJob[]>; log?: string; available?: CiProviderResult<null> };

function fakeProvider(script: Script) {
  const calls: string[] = [];
  const provider: CiProvider = {
    name: 'github',
    checkAvailable: async () => { calls.push('auth'); return script.available ?? { ok: true, value: null }; },
    listRuns: async () => { calls.push('runs'); return script.runs.length > 1 ? script.runs.shift()! : script.runs[0]!; },
    listJobs: async (_repository, runId) => { calls.push(`jobs:${runId}`); return { ok: true, value: script.jobs?.[runId] ?? [] }; },
    failedJobLog: async (_repository, runId, jobId) => { calls.push(`log:${runId}:${jobId}`); return { ok: true, value: script.log ?? '##[error]boom' }; },
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
  const watcher = new CiWatcher({ store: store.ci, registration, provider, clock });
  const request = (command: string, args: unknown): IpcRequest => ({ protocol: { major: 1, minor: 0 }, id: 'r', command, arguments: args });
  const watch = async () => await watcher.handle(request('ci.watch', { cwd: '/w/feat/src', branch: 'feat', headSha: sha }));
  const settle = async () => await watcher.idle();
  return { store, clock, calls, watcher, request, watch, settle };
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
  try {
    return {
      unsupportedRemote: await unsupportedRemote.watch(),
      missingGh: await missingGh.watch(),
      unauthenticated: await unauthenticated.watch(),
    };
  } finally {
    unsupportedRemote.store.close();
    missingGh.store.close();
    unauthenticated.store.close();
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
};

console.log(JSON.stringify(result));
