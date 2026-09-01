/**
 * The parts of a process identity that are the same question on every operating system, kept in one
 * place so the macOS and Linux readers cannot drift apart in the one field they must agree on the
 * *shape* of.
 *
 * `commandFingerprint` is the half of an identity that survives PID reuse in the cases start time
 * alone does not: two processes can plausibly share a start time to `ps`'s one-second resolution,
 * and the command is what tells them apart. It is only ever compared with another observation of
 * the same PID on the same host, never across hosts and never with the *planned* fingerprint the
 * supervisor hands the anchor — which is a hash of the argv it intends to run and deliberately not
 * the same function.
 */
import { createHash } from 'node:crypto';

/**
 * Moved verbatim from `packages/daemon/src/process-supervisor.ts`. The anchor case is why this is
 * not simply a hash of the command line: `wtm` starts a task by spawning an anchor whose last
 * argument is a 64-hex marker, and the anchor then `exec`s — or supervises — the real command, so
 * the observed command line changes underneath us. Collapsing a trailing marker to
 * `wtm-anchor:<marker>` makes the fingerprint stable across that transition, which is the whole
 * reason the supervisor can re-identify its own child after the anchor protocol completes.
 *
 * `executable` is what the platform calls the running image — the executable path on macOS, the
 * (15-byte truncated) `comm` on Linux. The two spell it differently and that is fine: a fingerprint
 * is compared only with other fingerprints taken by the same reader on the same machine.
 */
export function observedCommandFingerprint(executable: string, command: string): string {
  const anchorMarker = /(?:^|\s)([a-f0-9]{64})\s*$/.exec(command)?.[1];
  return createHash('sha256')
    .update(executable)
    .update('\0')
    .update(anchorMarker === undefined ? command : `wtm-anchor:${anchorMarker}`)
    .digest('hex');
}

/**
 * The `reason` carried by a `failed` inspection. It is a code, never a message: it reaches the JSON
 * error envelope, and an `errno` or a stray path in there would be both noise and a leak.
 */
export function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'UNKNOWN';
}
