import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

/**
 * `CiWatcher` cannot be exercised directly in a `bun test` process: it is built on
 * `SQLiteStateStore`, and constructing that store in-process under Bun panics (a better-sqlite3 /
 * Bun N-API interaction, not a bug in the store). `watcher.scenario.ts` runs every case below under
 * plain `node` instead, the way `heavy-job-finalization.scenario.ts` does, and prints one JSON line
 * this file asserts against — spawned once here and shared by every `test()` below.
 */
const scenarioPath = fileURLToPath(new URL('./watcher.scenario.ts', import.meta.url));
const scenario = runScenario('node', ['--import', 'tsx', scenarioPath]);
if (scenario.status !== 0) {
  throw new Error(`watcher.scenario.ts failed (status ${String(scenario.status)}):\n${scenario.stderr || scenario.stdout}`);
}
const result = JSON.parse(scenario.stdout) as Record<string, any>;

const sha = 'c'.repeat(40);
const base = Date.parse('2026-09-14T12:00:00.000Z');

describe('CiWatcher', () => {
  test('accepts a watch, polls, collects the failed job log and finishes', () => {
    const r = result.acceptPollAndFinish;
    expect(r.accepted).toMatchObject({ ok: true, data: { reused: false, watch: { state: 'pending', repo: 'github.com/acme/widgets', headSha: sha } } });
    expect(r.armedAfterAccept).toBe(1);
    expect(r.afterFirstPoll).toMatchObject({ state: 'pending', sawRuns: true, pollIntervalMs: 15_000 });
    expect(r.finished.state).toBe('failure');
    expect(r.finished.runs[0].jobs[0].logSummary).toBe('##[error]boom');
    expect(r.calls).toEqual(['auth', 'runs', 'jobs:7', 'runs', 'jobs:7', 'log:7:8']);
    expect(r.armedAfterFinish).toBe(0);
  });

  test('a successful commit never downloads logs', () => {
    const r = result.successNeverDownloadsLogs;
    expect(r.state).toBe('success');
    expect(r.downloadedLogs).toBe(false);
  });

  test('backs off without change and resets on change', () => {
    const r = result.backsOffAndResets;
    expect(r.afterTwo).toBe(22_500);
    expect(r.afterReset).toBe(15_000);
  });

  test('ends no_runs after 3 minutes and timed_out after 2 hours', () => {
    const r = result.noRunsAndTimedOut;
    expect(r.noRuns).toMatchObject({ state: 'no_runs' });
    expect(r.timedOut).toMatchObject({ state: 'timed_out' });
  });

  test('throttling delays, three unavailable answers end the watch', () => {
    const r = result.throttlingAndUnavailable;
    expect(r.throttledRecord).toMatchObject({ state: 'pending', failureStreak: 0, nextPollAt: new Date(base + 15_000 + 30_000).toISOString() });
    expect(r.unavailableRecord).toMatchObject({ state: 'unavailable', detail: 'HTTP 404' });
  });

  test('refuses an unsupported remote, a missing gh and an unauthenticated host', () => {
    const r = result.refusals;
    expect(r.unsupportedRemote).toMatchObject({ ok: false, errors: [{ code: 'WTM_CI_UNAVAILABLE', context: { remote: 'https://gitlab.com/g/s/p.git' } }] });
    expect(r.missingGh).toMatchObject({ ok: false, errors: [{ code: 'WTM_CI_UNAVAILABLE', context: { provider: 'github' } }] });
    expect(r.unauthenticated).toMatchObject({
      ok: false,
      errors: [{ code: 'WTM_CI_UNAVAILABLE', context: { provider: 'github', host: 'github.com' }, remediation: [{ kind: 'command-suggestion', argv: ['gh', 'auth', 'login', '--hostname', 'github.com'] }] }],
    });
  });

  test('unwatch cancels and disarms; an unregistered cwd is refused', () => {
    const r = result.unwatchAndUnregisteredCwd;
    expect(r.firstUnwatch).toMatchObject({ ok: true, data: { stopped: true, watch: { state: 'cancelled' } } });
    expect(r.armedAfterUnwatch).toBe(0);
    expect(r.secondUnwatch).toMatchObject({ ok: true, data: { stopped: false, watch: null } });
    expect(r.elsewhereWatch).toMatchObject({ ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND' }] });
  });

  test('start resumes pending watches and times out expired ones', () => {
    const r = result.restartResumesAndTimesOutExpired;
    expect(r.armedAfterResume).toBe(1);
    expect(r.resumedState).toBe('success');
    expect(r.expiredState).toBe('timed_out');
    expect(r.armedAfterExpiredResume).toBe(0);
  });

  test('spends at most 30 gh calls per minute', () => {
    const r = result.budgetCapsCallsPerMinute;
    expect(r.callsLength).toBeLessThanOrEqual(30);
  });

  // Fix round 1, finding 1: the checkAvailable probe must itself respect the 30-calls-per-minute
  // budget, skipping the probe (and still accepting the watch) rather than pushing past it.
  test('a full call budget skips the auth probe on re-watch and still accepts it', () => {
    const r = result.budgetFullSkipsAuthProbeOnRewatch;
    expect(r.callsAfterTick).toBe(30);
    expect(r.rewatch).toMatchObject({ ok: true, data: { reused: true, watch: { state: 'pending' } } });
    expect(r.callsAfterRewatch).toBe(r.callsAfterTick);
  });

  // Fix round 1, finding 2: a throttled/transient failedJobLog answer must delay the watch and
  // retry the same job on the next poll rather than settling for a placeholder summary.
  test('a throttled failedJobLog answer retries instead of settling for a placeholder', () => {
    const r = result.failedJobLogRetriesAfterThrottleThenSucceeds;
    expect(r.afterThrottle).toMatchObject({ state: 'pending' });
    expect(r.afterThrottle.runs[0].jobs[0].logSummary).toBeUndefined();
    expect(r.logCallsAfterThrottle).toBe(1);
    expect(r.finished.state).toBe('failure');
    expect(r.finished.runs[0].jobs[0].logSummary).toBe('##[error]boom');
    expect(r.logCallsFinal).toBe(2);
  });

  // Fix round 1, finding 3: a tick must re-read each watch immediately before polling it, so one
  // cancelled while an earlier watch's gh call for the same tick is still in flight is skipped.
  test('a watch cancelled while another watch is being polled in the same tick is not polled', () => {
    const r = result.tickSkipsWatchCancelledMidTick;
    expect(r.calls).toEqual(['auth', 'runs', 'jobs:7']);
    expect(r.wt2State).toBe('cancelled');
  });
});
