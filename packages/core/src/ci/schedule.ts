export const ciPollPolicy = {
  firstDelayMs: 15_000,
  growth: 1.5,
  maxIntervalMs: 120_000,
  maxThrottleMs: 600_000,
  noRunsAfterMs: 180_000,
  timeoutMs: 7_200_000,
  maxPending: 20,
  callsPerMinute: 30,
  unavailableAfterFailures: 3,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export function nextPollIntervalMs(previousMs: number | null, changed: boolean): number {
  if (previousMs === null || changed) return ciPollPolicy.firstDelayMs;
  return Math.min(Math.round(previousMs * ciPollPolicy.growth), ciPollPolicy.maxIntervalMs);
}

export function throttledDelayMs(intervalMs: number): number {
  return Math.min(intervalMs * 2, ciPollPolicy.maxThrottleMs);
}

export function ciDeadline(input: { startedAtMs: number; nowMs: number; sawRuns: boolean }): 'timed_out' | 'no_runs' | null {
  const elapsed = input.nowMs - input.startedAtMs;
  if (elapsed >= ciPollPolicy.timeoutMs) return 'timed_out';
  if (!input.sawRuns && elapsed >= ciPollPolicy.noRunsAfterMs) return 'no_runs';
  return null;
}
