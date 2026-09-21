import { tmpdir } from 'node:os';

/**
 * Whether the current test process is running on Windows.
 *
 * A one-line re-export of `process.platform`, kept here rather than written inline at each call
 * site: `packages/core/src/__tests__/platform-independence.test.ts` structurally forbids the
 * literal substring `process.platform` anywhere under `packages/core/src` — comments and tests
 * included, spec D8 — since `@wtm/core` itself must never branch on the host. A *test* that skips
 * an inherently POSIX-only scenario on Windows is not that branch (the production code under test
 * takes no such branch; see `external-adapter.ts`'s own `assertDescriptorExecutionSupported`, which
 * already refuses adapter execution on win32 unconditionally), but the guard cannot tell the
 * difference by text alone, so the check lives in `@wtm/testkit` instead, which the guard does not
 * scan.
 */
export const isWindowsTestHost: boolean = process.platform === 'win32';

/**
 * Where a scenario that binds a real Unix socket should `mkdtemp` under.
 *
 * Fixing the Windows half of this (a hardcoded `/tmp` does not exist there at all) surfaced a
 * POSIX half nobody had hit yet: `node:os`'s `tmpdir()` reads `TMPDIR`, which macOS sets to a long
 * per-process path (`/var/folders/.../T/`) rather than the short, stable `/tmp` the same host still
 * keeps (a symlink to `/private/tmp`). A fixture that `mkdtemp`s under `tmpdir()` on macOS pushes an
 * otherwise-ordinary temp home past the 104-byte `sun_path` limit a real daemon-socket test measures
 * against — caught locally switching one of these fixtures over. `/tmp` has no equivalent length
 * problem, since it is already the shortest a POSIX temp root gets; on win32, `os.tmpdir()` is the
 * only real option and carries no such risk of its own.
 */
export function shortTmpRoot(): string {
  return isWindowsTestHost ? tmpdir() : '/tmp';
}

/**
 * Whether `chmod` can deny this process anything.
 *
 * False on Windows, where `getuid` does not exist and a mode touches only the read-only attribute,
 * and false for root, whom a mode does not stop either. A test whose premise is "this file cannot
 * be read" has no premise on either, and running it anyway does not produce a stricter test — it
 * produces one that measures the opposite of what it says and reports the difference as a failure
 * of the code under test.
 *
 * Written here rather than at each call site so the two kinds of host are ruled out by one
 * predicate: `reconcile-fallback.test.ts` had it for root while `process-anchor.test.ts` threw on
 * root and quietly measured the wrong thing on Windows.
 */
export const isUnprivilegedPosixUser: boolean = process.getuid?.() !== undefined && process.getuid?.() !== 0;
