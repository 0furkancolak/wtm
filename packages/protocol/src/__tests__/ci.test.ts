import { describe, expect, test } from 'bun:test';
import { ciArgumentSchemas, ciCommandNames, ciWatchAcceptanceSchema, ciWatchSchema, prSummarySchema, wtmErrorCodeSchema } from '../index';

const sha = 'a'.repeat(40);
const watch = {
  watchId: 'w-1', repo: 'github.com/acme/widgets', branch: 'feat/x', headSha: sha, state: 'failure',
  startedAt: '2026-09-14T12:00:00.000Z', updatedAt: '2026-09-14T12:05:00.000Z', finishedAt: '2026-09-14T12:05:00.000Z',
  runs: [{
    runId: 1, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/1',
    jobs: [{ jobId: 2, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/1/job/2', logSummary: 'boom' }],
  }],
};

describe('ci protocol', () => {
  test('declares exactly the daemon-backed ci commands', () => {
    expect([...ciCommandNames].sort()).toEqual(['ci.unwatch', 'ci.watch']);
  });

  test('accepts a watch request and refuses unknown fields and bad commits', () => {
    expect(ciArgumentSchemas['ci.watch'].safeParse({ cwd: '/repo', branch: 'main', headSha: sha }).success).toBe(true);
    expect(ciArgumentSchemas['ci.watch'].safeParse({ cwd: '/repo', branch: null, headSha: 'b'.repeat(64), pr: 7 }).success).toBe(true);
    expect(ciArgumentSchemas['ci.watch'].safeParse({ cwd: '/repo', branch: 'main', headSha: 'HEAD' }).success).toBe(false);
    expect(ciArgumentSchemas['ci.watch'].safeParse({ cwd: '/repo', branch: 'main', headSha: sha, token: 'x' }).success).toBe(false);
    expect(ciArgumentSchemas['ci.unwatch'].safeParse({ cwd: '/repo' }).success).toBe(true);
  });

  test('validates a finished watch and its acceptance', () => {
    expect(ciWatchSchema.safeParse(watch).success).toBe(true);
    expect(ciWatchSchema.safeParse({ ...watch, state: 'green' }).success).toBe(false);
    expect(ciWatchSchema.safeParse({ ...watch, runs: [{ ...watch.runs[0], jobs: [{ ...watch.runs[0]!.jobs[0], logSummary: 'x'.repeat(8193) }] }] }).success).toBe(false);
    expect(ciWatchAcceptanceSchema.safeParse({ watch, reused: false }).success).toBe(true);
  });

  test('knows the CI error code', () => {
    expect(wtmErrorCodeSchema.safeParse('WTM_CI_UNAVAILABLE').success).toBe(true);
  });

  test('validates a PR summary, with checks optional and unknown fields refused', () => {
    const pr = { number: 42, url: 'https://github.com/acme/widgets/pull/42', state: 'open', mergeable: 'mergeable', checks: 'pending' };
    expect(prSummarySchema.safeParse(pr).success).toBe(true);
    const { checks: _checks, ...withoutChecks } = pr;
    expect(prSummarySchema.safeParse(withoutChecks).success).toBe(true);
    expect(prSummarySchema.safeParse({ ...pr, state: 'draft' }).success).toBe(false);
    expect(prSummarySchema.safeParse({ ...pr, checks: 'green' }).success).toBe(false);
    expect(prSummarySchema.safeParse({ ...pr, extra: true }).success).toBe(false);
  });
});
