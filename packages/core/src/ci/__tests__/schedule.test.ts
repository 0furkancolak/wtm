import { describe, expect, test } from 'bun:test';
import { ciDeadline, ciPollPolicy, nextPollIntervalMs, throttledDelayMs } from '../schedule';

describe('ci poll schedule', () => {
  test('starts at 15 s, grows by 1.5 up to 2 min, resets on change', () => {
    expect(nextPollIntervalMs(null, false)).toBe(15_000);
    expect(nextPollIntervalMs(15_000, false)).toBe(22_500);
    expect(nextPollIntervalMs(100_000, false)).toBe(120_000);
    expect(nextPollIntervalMs(120_000, false)).toBe(120_000);
    expect(nextPollIntervalMs(120_000, true)).toBe(15_000);
  });
  test('throttling doubles up to 10 min', () => {
    expect(throttledDelayMs(15_000)).toBe(30_000);
    expect(throttledDelayMs(400_000)).toBe(600_000);
  });
  test('deadlines', () => {
    const startedAtMs = 0;
    expect(ciDeadline({ startedAtMs, nowMs: 179_999, sawRuns: false })).toBeNull();
    expect(ciDeadline({ startedAtMs, nowMs: 180_000, sawRuns: false })).toBe('no_runs');
    expect(ciDeadline({ startedAtMs, nowMs: 180_000, sawRuns: true })).toBeNull();
    expect(ciDeadline({ startedAtMs, nowMs: 7_200_000, sawRuns: true })).toBe('timed_out');
    expect(ciDeadline({ startedAtMs, nowMs: 7_200_000, sawRuns: false })).toBe('timed_out');
  });
  test('policy values match the spec', () => {
    expect(ciPollPolicy).toEqual({
      firstDelayMs: 15_000, growth: 1.5, maxIntervalMs: 120_000, maxThrottleMs: 600_000,
      noRunsAfterMs: 180_000, timeoutMs: 7_200_000, maxPending: 20, callsPerMinute: 30,
      unavailableAfterFailures: 3, retentionMs: 604_800_000,
    });
  });
});
