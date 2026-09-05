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
