import { describe, expect, test } from 'bun:test';
import type { CiRun } from '@wtm/protocol';
import { aggregateCiRuns, isFailingConclusion } from '../aggregate';

const run = (status: string, conclusion: string | null, runId = 1): CiRun => ({
  runId, workflow: 'CI', event: 'push', status, conclusion, url: `https://example.test/${runId}`, jobs: [],
});

describe('aggregateCiRuns', () => {
  test('no runs is none', () => expect(aggregateCiRuns([])).toBe('none'));
  test('an unfinished run keeps it pending', () => {
    expect(aggregateCiRuns([run('completed', 'failure', 1), run('in_progress', null, 2)])).toBe('pending');
    expect(aggregateCiRuns([run('queued', null)])).toBe('pending');
  });
  test('success, skipped and neutral succeed', () => {
    expect(aggregateCiRuns([run('completed', 'success', 1), run('completed', 'skipped', 2), run('completed', 'neutral', 3)])).toBe('success');
  });
  test('failure beats cancelled beats success', () => {
    expect(aggregateCiRuns([run('completed', 'cancelled', 1), run('completed', 'failure', 2)])).toBe('failure');
    expect(aggregateCiRuns([run('completed', 'cancelled', 1), run('completed', 'success', 2)])).toBe('cancelled');
  });
  test.each(['failure', 'timed_out', 'startup_failure', 'action_required', 'stale', null])('%p fails a completed run', (conclusion) => {
    expect(aggregateCiRuns([run('completed', conclusion)])).toBe('failure');
    expect(isFailingConclusion(conclusion)).toBe(true);
  });
  test.each(['success', 'skipped', 'neutral', 'cancelled'])('%p is not failing', (conclusion) => {
    expect(isFailingConclusion(conclusion)).toBe(false);
  });
});
