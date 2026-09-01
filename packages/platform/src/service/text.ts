/**
 * The value checks the definition renderers and the publisher share.
 *
 * They are shared rather than copied because both backends embed the same values — a label, a
 * HOME, an argument vector — into a structured text file that a service manager parses, and a
 * control character that one renderer rejects and the other escapes is a difference nobody
 * intended. The names lost their `Xml` spelling in the move: the rule was never about XML, it is
 * about what may appear in a file another program parses.
 */
import { isAbsolute, resolve } from 'node:path';
import { configurationError } from './errors';

/** What is retained of a service manager's own output when it is reported back to a user. */
export const maxCommandOutputBytes = 4 * 1024;

export function assertPrintableValue(value: string, label: string): void {
  if (value.length === 0 || value.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw configurationError(`${label} is invalid`);
  }
}

export function assertAbsolutePath(path: string, label: string): void {
  assertPrintableValue(path, label);
  if (!isAbsolute(path)) throw configurationError(`${label} must be absolute`);
}

/**
 * Truncates on bytes, not characters, and replaces the control codes: this text ends up in an
 * error context that is rendered as JSON and printed to a terminal, and a service manager's
 * output is not a value this process chose.
 */
export function sanitizeCommandOutput(value: string): string {
  return Buffer.from(value)
    .subarray(0, maxCommandOutputBytes)
    .toString('utf8')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD');
}

/**
 * The `PATH` an installed service will run with, normalised and checked.
 *
 * A service manager starts a job with an environment that has no relation to any shell the user
 * configured, so this value is the only `PATH` the daemon will ever see and a relative entry in it
 * would resolve against a working directory nobody chose.
 */
export function sanitizePathEnvironment(value: string, manager: string): string {
  if (value.length === 0 || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw configurationError(`${manager} PATH is invalid`);
  }
  const entries = value.split(':');
  if (entries.some((entry) => entry.length === 0 || !isAbsolute(entry))) {
    throw configurationError(`${manager} PATH entries must be absolute`);
  }
  return [...new Set(entries.map((entry) => resolve(entry)))].join(':');
}
