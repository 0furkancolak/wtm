/**
 * The port `@wtm/core`'s own resource-safety checks ask, declared here rather than imported from
 * `@wtm/platform` — core must not import a platform package at all (a structural guard,
 * `__tests__/platform-independence.test.ts`, enforces exactly that), the same reason
 * `analysis/operation-lease.ts` declares its own `ProcessStartTimeReader` rather than importing
 * `ProcessPlatform`'s type. `@wtm/platform`'s `FileTrustPolicy` (`packages/platform/src/ports.ts`)
 * is written to this exact shape and satisfies it structurally, with no import needed in either
 * direction; the composition roots (the CLI and the daemon) are what actually hand one across the
 * package boundary, as a plain object of functions.
 *
 * Before Increment D1 (spec `2026-09-03-windows-trust-and-transport-seam.md`, D2/D4), the three
 * predicates below were inline `process.getuid()`/`stat.mode`/`stat.nlink` comparisons repeated at
 * every call site in `guard.ts`, `preparation.ts`, `removal.ts`, `materializer.ts`, `gc.ts`,
 * `adapter-trust.ts` and `private-directory.ts`. Migrating a call site to this port is a
 * substitution of the same comparison, not a redesign — see `FileTrustPolicy`'s own doc comment in
 * `@wtm/platform` for why the interface has exactly these four methods and no others.
 */
/**
 * `number | bigint` because `fs.Stats`'s sibling type `fs.BigIntStats` (returned when a caller
 * asks `lstat` for `{ bigint: true }`) reports these as `bigint`, and `Awaited<ReturnType<typeof
 * lstat>>` — the type every migrated call site already used before this port existed — is typed as
 * the union of both, even though nothing in this codebase actually requests `bigint: true`. Every
 * implementation normalises with `Number(...)` before comparing.
 */
export interface CoreFileStat {
  uid: number | bigint;
  mode: number | bigint;
  nlink: number | bigint;
}

/** `0o022` denies group/other *write*; `0o077` denies group/other *any access*. Both are real,
 * distinct questions the call sites already ask — see the `isWritableOnlyByOwner` doc below. */
export type OwnerOnlyMask = 0o022 | 0o077;

export interface FileTrustPolicy {
  /** `false` also when the current user's own identity cannot be determined at all. */
  isOwnedByCurrentUser(stat: CoreFileStat, path: string): Promise<boolean>;
  /**
   * The mask is the caller's question, not the port's: `guard.ts`'s `assertSafeDirectory` asks
   * "no group/other write" (`0o022`), `private-directory.ts` asks the stricter "no group/other
   * access at all" (`0o077`) — flattening the two into one fixed mask would silently change
   * whichever call site's question was not the one kept.
   */
  isWritableOnlyByOwner(stat: CoreFileStat, path: string, mask: OwnerOnlyMask): Promise<boolean>;
  isNotSharedByHardLink(stat: CoreFileStat): boolean;
  /** `false` on any platform where per-user file ownership cannot be read at all. */
  currentIdentityAvailable(): boolean;
}

/**
 * The POSIX answer — `process.getuid()`, a caller-chosen mode mask, `stat.nlink` — every call
 * site already computed inline before this port existed, kept here as core's own default so that
 * migrating a call site to the port changes nothing for the two platforms core already ran on.
 *
 * This **duplicates** `@wtm/platform`'s `posixFileTrustPolicy` rather than importing it — core
 * cannot import `@wtm/platform` at all (the structural guard this file's own migration extends
 * forbids it), so there is no way to share one implementation across the package boundary the way
 * `readStartTime` shares one *port type* without sharing an implementation. The duplication is
 * exactly what it looks like: two copies of three comparisons, not two designs that could drift on
 * what a "current user" or a "group/other write" check means — both read `process.getuid()` and a
 * `fs.Stats`, and neither has a decision to make.
 */
export const defaultCoreFileTrustPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser(stat: CoreFileStat, _path: string): Promise<boolean> {
    const currentUid = process.getuid?.();
    return Promise.resolve(currentUid !== undefined && Number(stat.uid) === currentUid);
  },
  isWritableOnlyByOwner(stat: CoreFileStat, _path: string, mask: OwnerOnlyMask): Promise<boolean> {
    return Promise.resolve((Number(stat.mode) & mask) === 0);
  },
  isNotSharedByHardLink(stat: CoreFileStat): boolean {
    return Number(stat.nlink) === 1;
  },
  currentIdentityAvailable(): boolean {
    return process.getuid?.() !== undefined;
  },
};
