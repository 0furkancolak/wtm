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
