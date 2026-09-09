/** Queue tasks must finish within a bounded time; arbitrary duration syntax is not accepted. */
export function queueTaskTimeoutMs(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value ?? '');
  if (match === null) return null;
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  const duration = Number(match[1]) * factor;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= 86_400_000 ? duration : null;
}
