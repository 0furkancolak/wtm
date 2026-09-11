import { expect, test } from 'bun:test';
import { jobWaitingReasons, type JobSchedulingEntry } from '../job-scheduling';
import { memoryEstimateError, type JobMemoryAdmission } from '../job-memory';

const memory: JobMemoryAdmission = { budgetBytes: 800, reserveBytes: 200, availableBytes: 1000, totalBytes: 2000 };
const entry = (jobId: string, memoryEstimateBytes: number | null, extra: Partial<JobSchedulingEntry> = {}): JobSchedulingEntry => ({
  jobId, state: 'QUEUED', slotHeld: false, worktreeBusy: false, memoryEstimateBytes, ...extra,
});

test('memory admission preserves FIFO and does not let a smaller follower starve its head', () => {
  const entries = [entry('large', 600), entry('small', 100)];
  expect([...jobWaitingReasons(entries, 4, { ...memory, availableBytes: 700 })]).toEqual([
    ['large', 'memory_budget'], ['small', 'fifo'],
  ]);
  expect(jobWaitingReasons(entries, 4, memory).get('large')).toBe('dispatch_pending');
});

test('held estimates reserve growth room until cleanup is proved, even after a stop request', () => {
  const entries = [entry('held', 500, { state: 'RUNNING', slotHeld: true }), entry('next', 400)];
  expect(jobWaitingReasons(entries, 4, memory).get('next')).toBe('memory_budget');
  expect(jobWaitingReasons([entry('next', 400)], 4, memory).get('next')).toBe('dispatch_pending');
});

test('missing held estimates and unavailable or invalid memory evidence block new starts', () => {
  expect(jobWaitingReasons([entry('old', null, { state: 'RUNNING', slotHeld: true }), entry('next', 1)], 4, memory).get('next')).toBe('memory_budget');
  for (const availableBytes of [null, -1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
    expect(jobWaitingReasons([entry('next', 1)], 4, { ...memory, availableBytes }).get('next')).toBe('memory_budget');
  }
});

test('configured budget and headroom both apply without weakening existing capacity/worktree gates', () => {
  expect(jobWaitingReasons([entry('a', 801)], 1, memory).get('a')).toBe('memory_budget');
  expect(jobWaitingReasons([entry('a', 800)], 1, memory).get('a')).toBe('dispatch_pending');
  expect(jobWaitingReasons([entry('a', 800, { worktreeBusy: true })], 1, memory).get('a')).toBe('worktree_busy');
  expect(jobWaitingReasons([entry('h', 1, { state: 'RUNNING', slotHeld: true }), entry('a', 1)], 1, memory).get('a')).toBe('concurrency');
});

test('temporary shortage is distinct from a request that can never fit', () => {
  expect(memoryEstimateError(600, { ...memory, availableBytes: 1 })).toBeNull();
  expect(memoryEstimateError(801, memory)).toBe('WTM_JOB_MEMORY_BUDGET_EXCEEDED');
  expect(memoryEstimateError(600, { ...memory, totalBytes: 700 })).toBe('WTM_JOB_MEMORY_BUDGET_EXCEEDED');
  expect(memoryEstimateError(null, memory)).toBe('WTM_JOB_MEMORY_ESTIMATE_REQUIRED');
  expect(memoryEstimateError(1.5, memory)).toBe('WTM_JOB_MEMORY_ESTIMATE_REQUIRED');
});

test('concurrency-only admission stays compatible with legacy jobs without estimates', () => {
  expect(jobWaitingReasons([entry('old', null)], 1).get('old')).toBe('dispatch_pending');
});
