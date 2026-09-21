import type { PlatformId } from '../ports';

/**
 * How long one identity observation may take, per platform.
 *
 * Every reader in this package answers "who is this process" by asking the operating system in its
 * own dialect, and the three dialects do not cost the same. The number that bounds that ask was
 * written out at each call site, which is how it came to be three different numbers for one
 * platform: `trust/windows-powershell.ts` raised its own bound from 5 s to 15 s after measuring a
 * cold `powershell.exe` at roughly 1.6 s plus real CI contention, `process/windows.ts` carries 15 s
 * for `taskkill.exe` after a real `windows-latest` leg produced `ETIMEDOUT` at 5 s — and the
 * anchor's inlined copy of the same reader (`daemon/src/process-anchor.ts`) was still at 5 s,
 * having been written before either correction and never revisited. An anchor that cannot finish
 * its own identity read inside its own bound never reports `READY`, which the supervisor reads as
 * `ANCHOR_HANDSHAKE_INVALID` and the caller as `RUNTIME_START_FAILED`.
 *
 * So the number lives here once, and the call sites read it.
 *
 * - **darwin** — one `ps` invocation. 1 s is the bound `process/darwin.ts` has always used.
 * - **linux** — a `/proc` read, which spawns nothing. The bound is a ceiling on a read that should
 *   not approach it, not a measurement of one.
 * - **win32** — a `powershell.exe` start plus a WMI query. The 15 s is the one this repository has
 *   already twice corrected upward against a real Windows runner, and it is a bound on a *cost*,
 *   not a claim that the query is slow: what it buys is that a contended runner does not turn a
 *   healthy observation into a failed start.
 *
 * A consumer that waits *on* an observation has to be more patient than the observation itself —
 * `daemon/src/process-supervisor.ts`'s `anchorProtocolTimeoutMs` is the one that matters, and its
 * own test pins the inequality.
 */
export const processObservationBudgetMs: Readonly<Record<PlatformId, number>> = {
  darwin: 1_000,
  linux: 1_000,
  win32: 15_000,
};

export function processObservationBudgetFor(platform: PlatformId): number {
  return processObservationBudgetMs[platform];
}
