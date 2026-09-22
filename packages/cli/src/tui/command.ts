import type { WtmError } from '@wtm/protocol';

/**
 * Whether `wtm tui` may run at all: it draws an alternate-screen, raw-mode dashboard, which means
 * nothing when stdout is piped, redirected or attached to a CI runner. Refusing cleanly here is
 * what keeps that case a one-line error instead of a garbled screen or a hang waiting on input
 * nobody can send.
 *
 * Pure and TTY-free by design, so it is unit-testable without a real terminal: pass a plain
 * `{ isTTY }` object, never `process.stdout` itself, from a test.
 */
export function tuiNonInteractiveRefusal(stdout: { readonly isTTY?: boolean }): WtmError | null {
  if (stdout.isTTY === true) return null;
  return {
    code: 'WTM_CONFIG_INVALID',
    message: 'wtm tui needs an interactive terminal. stdout is not a TTY (piped output, a '
      + 'redirect, or CI) — run it directly in a terminal instead.',
    severity: 'error',
  };
}

const defaultIntervalMs = 3000;
const minIntervalMs = 250;

/** Parses `--interval <ms>`, refusing anything that would not be a sane polling cadence. */
export function parseTuiIntervalMs(value: string | undefined): number {
  if (value === undefined) return defaultIntervalMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minIntervalMs) {
    throw new RangeError(`--interval must be a number of milliseconds, at least ${minIntervalMs}`);
  }
  return parsed;
}
