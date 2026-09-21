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
 * `@wtm/platform` for why the interface has exactly these five methods and no others.
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
  /**
   * Whether the filesystem marks this path runnable. `true` on a platform that records no
   * executable bit, where the filesystem does not decide runnability and the caller's own format
   * check does — `@wtm/platform`'s `FileTrustPolicy` carries the full reasoning.
   */
  isExecutable(stat: CoreFileStat, path: string): Promise<boolean>;
  /**
   * Whether this host could read `path`'s ownership and access rules at all — asked only to decide
   * whether a refusal the predicates above produced is one a person has to clear or one a retry
   * may clear (todo item 51, M3). Absent is the POSIX answer: nothing there can make an already-read
   * `stat` unreadable. `@wtm/platform`'s `FileTrustPolicy` carries the full reasoning.
   */
  ownershipReadable?(path: string): Promise<boolean>;
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
 *
 * Reachable from outside this package as `@wtm/core/file-trust-policy` — a subpath rather than the
 * main barrel, deliberately. The one caller is a test that needs to name the thing which actually
 * answers when nobody injects, instead of hand-writing a lookalike that would keep passing if this
 * changed. Production code has no reason to import it: a composition root reaching for this is one
 * that should be selecting `PlatformRuntime.fileTrust` instead, and keeping it off the barrel keeps
 * it out of everyone's auto-import suggestions. The types beside it stay unexported for a sharper
 * reason — a second exported `FileTrustPolicy` declaration, structurally identical to
 * `@wtm/platform/ports`'s but a distinct one, is exactly the confusion this seam exists to avoid.
 */
export const defaultCoreFileTrustPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser(stat: CoreFileStat, _path: string): Promise<boolean> {
    const currentUid = process.getuid?.();
    return Promise.resolve(currentUid !== undefined && Number(stat.uid) === currentUid);
  },
  isWritableOnlyByOwner(stat: CoreFileStat, _path: string, mask: OwnerOnlyMask): Promise<boolean> {
    return Promise.resolve((Number(stat.mode) & mask) === 0);
  },
  /**
   * `nlink > 1` is the only shape that means "another name points at this inode". `nlink === 0` is
   * an `fstat` of a descriptor whose last directory entry has already been removed -- an anonymous
   * inode no second name can reach, so it is the opposite of shared. Refusing it turns a
   * rename-over-a-held-descriptor race into a hard refusal: `@wtm/daemon`'s managed log reader hit
   * exactly that on macOS CI, and core's own fd-stat callers (`adapter-trust.ts`,
   * `materializer.ts`) can hit it the same way. Kept byte-equivalent to `@wtm/platform`'s
   * `posixFileTrustPolicy`, which `file-trust-guard.test.ts` pins.
   */
  isNotSharedByHardLink(stat: CoreFileStat): boolean {
    return Number(stat.nlink) <= 1;
  },
  currentIdentityAvailable(): boolean {
    return process.getuid?.() !== undefined;
  },
  /**
   * POSIX's own answer, kept byte-equivalent to `@wtm/platform`'s `posixFileTrustPolicy` like
   * every predicate above it. A caller who reaches this fallback on Windows gets a refusal, which
   * is the same fail-closed behaviour the other four give there and the reason a composition root
   * is expected to inject `PlatformRuntime.fileTrust` instead.
   */
  isExecutable(stat: CoreFileStat, _path: string): Promise<boolean> {
    return Promise.resolve((Number(stat.mode) & 0o111) !== 0);
  },
};
