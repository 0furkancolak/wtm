import { describe, expect, test } from 'bun:test';
import { parseCiRemote } from '@wtm/core';
import type { GhCommandResult } from '../gh-runner';
import { createGitHubProvider } from '../github-provider';

const repository = parseCiRemote('https://github.com/acme/widgets.git')!;
const ok = (stdout: string): GhCommandResult => ({ outcome: 'success', exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, outcome: GhCommandResult['outcome'] = 'failure'): GhCommandResult => ({ outcome, exitCode: outcome === 'failure' ? 1 : null, stdout: '', stderr });

function recording(results: GhCommandResult[]) {
  const calls: string[][] = [];
  const provider = createGitHubProvider(async (argv) => { calls.push([...argv]); return results.shift() ?? fail('no scripted result'); });
  return { calls, provider };
}

describe('GitHub CI provider', () => {
  test('checks authentication for the repository host', async () => {
    const { calls, provider } = recording([ok('')]);
    expect(await provider.checkAvailable(repository)).toEqual({ ok: true, value: null });
    expect(calls).toEqual([['auth', 'status', '--hostname', 'github.com']]);
  });

  test.each([
    [fail('', 'not-found'), { kind: 'unavailable', reason: 'missing' }],
    [fail('You are not logged into any GitHub hosts. Run gh auth login to authenticate.'), { kind: 'unavailable', reason: 'unauthenticated' }],
    [fail('', 'timeout'), { kind: 'transient' }],
  ])('classifies auth failures', async (result, expected) => {
    const { provider } = recording([result]);
    const answer = await provider.checkAvailable(repository);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.failure).toMatchObject(expected);
  });

  test('lists every run of a commit', async () => {
    const { calls, provider } = recording([ok(JSON.stringify([
      { databaseId: 11, workflowName: 'CI', event: 'push', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/11' },
      { databaseId: 12, workflowName: 'CI', event: 'pull_request', status: 'in_progress', conclusion: '', url: 'https://github.com/acme/widgets/actions/runs/12' },
    ]))]);
    const answer = await provider.listRuns(repository, 'a'.repeat(40));
    expect(calls[0]).toEqual(['run', 'list', '--repo', 'github.com/acme/widgets', '--commit', 'a'.repeat(40), '--limit', '50', '--json', 'databaseId,workflowName,event,status,conclusion,url']);
    expect(answer).toEqual({ ok: true, value: [
      { runId: 11, workflow: 'CI', event: 'push', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/11', jobs: [] },
      { runId: 12, workflow: 'CI', event: 'pull_request', status: 'in_progress', conclusion: null, url: 'https://github.com/acme/widgets/actions/runs/12', jobs: [] },
    ] });
  });

  test('lists jobs and reads a failed job log', async () => {
    const { calls, provider } = recording([
      ok(JSON.stringify({ jobs: [{ databaseId: 21, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/11/job/21', steps: [] }] })),
      ok('test\tstep\t2026-09-14T11:00:00.0000000Z ##[error]boom\n'),
    ]);
    expect(await provider.listJobs(repository, 11)).toEqual({ ok: true, value: [
      { jobId: 21, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/acme/widgets/actions/runs/11/job/21' },
    ] });
    expect(await provider.failedJobLog(repository, 11, 21)).toEqual({ ok: true, value: 'test\tstep\t2026-09-14T11:00:00.0000000Z ##[error]boom\n' });
    expect(calls).toEqual([
      ['run', 'view', '11', '--repo', 'github.com/acme/widgets', '--json', 'jobs'],
      ['run', 'view', '11', '--repo', 'github.com/acme/widgets', '--job', '21', '--log-failed'],
    ]);
  });

  test.each([
    ['HTTP 403: API rate limit exceeded for user', 'throttled'],
    ['HTTP 429: secondary rate limit', 'throttled'],
    ['HTTP 502: Bad Gateway', 'transient'],
    ['dial tcp: i/o timeout', 'transient'],
    ['HTTP 404: Not Found', 'unavailable'],
    ['GraphQL: Could not resolve to a Repository with the name', 'unavailable'],
    ['HTTP 401: Bad credentials', 'unavailable'],
  ])('classifies %s', async (stderr, kind) => {
    const { provider } = recording([fail(stderr)]);
    const answer = await provider.listRuns(repository, 'a'.repeat(40));
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.failure.kind).toBe(kind as 'throttled');
  });

  test('treats unexpected output as transient', async () => {
    const { provider } = recording([ok('not json')]);
    const answer = await provider.listRuns(repository, 'a'.repeat(40));
    expect(answer).toMatchObject({ ok: false, failure: { kind: 'transient' } });
  });
});
