import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('ci watch follows a failing run through a fake gh and ci status reports it locally', () => {
  const scenarioPath = fileURLToPath(new URL('./ci-watch.scenario.ts', import.meta.url));
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  const { watched, pendingStatus, afterFirstPoll, finalStatus, all, calls } = JSON.parse(result.stdout);

  expect(watched.envelope).toMatchObject({
    ok: true, command: 'ci watch', data: { reused: false, watch: { state: 'pending', repo: 'github.com/acme/widgets', pr: 12 } },
  });
  expect(pendingStatus.envelope).toMatchObject({ ok: true, data: { watch: { state: 'pending', runs: [] } } });
  expect(afterFirstPoll.envelope).toMatchObject({ ok: true, data: { watch: { state: 'pending', runs: [{ runId: 501, status: 'in_progress' }] } } });

  const watch = finalStatus.envelope.data.watch;
  expect(watch).toMatchObject({ state: 'failure', runs: [{ runId: 501, conclusion: 'failure', jobs: [{ jobId: 601, conclusion: 'failure' }] }] });
  const summary: string = watch.runs[0].jobs[0].logSummary;
  expect(summary).toContain('##[error]expected 2 to be 3');
  expect(summary).toContain('[masked]');
  expect(summary).not.toContain('ghp_');
  expect(summary).not.toContain('UNKNOWN STEP');

  expect(all.envelope).toMatchObject({ ok: true, data: { watches: [{ watch: { state: 'failure' } }] } });
  // ci status never ran gh: every gh call came from the watcher.
  expect(calls.map((call: string[]) => call.slice(0, 2).join(' '))).toEqual(['auth status', 'run list', 'run view', 'run list', 'run view', 'run view']);
});
