/**
 * The one duration grammar task-level bounds are written in: `ms`, `s`, `m` or `h`, resolving to
 * whole milliseconds inside the caller's bounds. `@wtm/protocol`'s `readinessDurationMs` is the
 * same grammar without `h` and capped at five minutes, which is right for an observation deadline
 * and too short for anything measured in hours.
 */
function boundedTaskDurationMs(value: string | undefined, minimumMs: number, maximumMs: number): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value ?? '');
  if (match === null) return null;
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  const duration = Number(match[1]) * factor;
  return Number.isSafeInteger(duration) && duration >= minimumMs && duration <= maximumMs ? duration : null;
}

/** The longest either bound below may be: a day. */
export const maximumTaskDurationMs = 86_400_000;

/** Queue tasks must finish within a bounded time; arbitrary duration syntax is not accepted. */
export function queueTaskTimeoutMs(value: string | undefined): number | null {
  return boundedTaskDurationMs(value, 1, maximumTaskDurationMs);
}

/**
 * The floor under an idle window, and the reason it is not 1 ms the way the queue timeout's is:
 * idleness is decided by a periodic sweep whose interval is measured in seconds, so a window
 * finer than the sweep cannot be honoured and would only promise a precision nothing delivers.
 */
export const minimumIdleTimeoutMs = 1_000;

/** `[tasks.<name>.idle] timeout`: how long a managed task may go unused before it is stopped. */
export function idleTimeoutMs(value: string | undefined): number | null {
  return boundedTaskDurationMs(value, minimumIdleTimeoutMs, maximumTaskDurationMs);
}
