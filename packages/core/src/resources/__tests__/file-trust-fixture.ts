/**
 * A host-independent `FileTrustPolicy` test double for `packages/core/src/resources/__tests__/`.
 *
 * `defaultCoreFileTrustPolicy` (`../../file-trust-policy.ts`) is explicitly documented as core's
 * POSIX-only fallback -- it reads the process's real user id (what `getuid()` returns) and raw
 * `fs.Stats.mode` bits, which is exactly right for the two platforms core ran on before Windows
 * support existed, and exactly wrong to rely on from a test that must also make sense on a Windows
 * CI leg: that id function has nothing to return there, and Node's `fs.Stats.mode` does not reflect
 * real NTFS permissions at all.
 *
 * This fixture answers the same four questions without consulting either. "Owned by the current
 * user" and "writable only by the owner" default to `true` -- correct for every directory and file
 * a test creates for itself, on any host -- and a test that needs a specific path to read as
 * *untrusted* says so explicitly via `denyOwnership`/`denyOwnerOnlyWrite`, rather than leaning on a
 * real ambient uid or mode comparison that would mean something different, or nothing at all, on a
 * different platform. The deny-lists are keyed by `realpath`, resolved at both mark time and check
 * time, so a path reaches the same entry whether the caller (the test, or the guarded code under
 * test) spells it through a symlinked temp root or not -- the two are not guaranteed to agree
 * character-for-character, only to name the same object.
 *
 * `isNotSharedByHardLink` is the one predicate answered for real, from `stat.nlink`: unlike a uid or
 * a mode bit, a hard-link count is a plain fact every platform in scope reports the same way, and
 * the hardlink-rejection tests in this suite already produce it honestly by calling `link()`.
 */
import { realpath } from 'node:fs/promises';
import type { CoreFileStat, FileTrustPolicy } from '../../file-trust-policy';

export interface FakeFileTrust extends FileTrustPolicy {
  /** From now on, `isOwnedByCurrentUser` reports `false` for whatever real object currently sits at `path`. */
  denyOwnership(path: string): Promise<void>;
  /** From now on, `isWritableOnlyByOwner` reports `false` for whatever real object currently sits at `path`. */
  denyOwnerOnlyWrite(path: string): Promise<void>;
  /** From now on, `currentIdentityAvailable` reports `false`, as on a host with no identity source. */
  denyIdentity(): void;
}

/** Creates a fixture that trusts everything until the test says otherwise. */
export function createFakeFileTrust(): FakeFileTrust {
  const deniedOwnership = new Set<string>();
  const deniedOwnerOnlyWrite = new Set<string>();
  let identityAvailable = true;

  const canonicalize = async (path: string): Promise<string> => realpath(path).catch(() => path);

  return {
    async isOwnedByCurrentUser(_stat: CoreFileStat, path: string): Promise<boolean> {
      if (!identityAvailable) return false;
      return !deniedOwnership.has(await canonicalize(path));
    },
    async isWritableOnlyByOwner(_stat: CoreFileStat, path: string): Promise<boolean> {
      return !deniedOwnerOnlyWrite.has(await canonicalize(path));
    },
    isNotSharedByHardLink(stat: CoreFileStat): boolean {
      return Number(stat.nlink) === 1;
    },
    currentIdentityAvailable(): boolean {
      return identityAvailable;
    },
    async denyOwnership(path: string): Promise<void> {
      deniedOwnership.add(await canonicalize(path));
    },
    async denyOwnerOnlyWrite(path: string): Promise<void> {
      deniedOwnerOnlyWrite.add(await canonicalize(path));
    },
    denyIdentity(): void {
      identityAvailable = false;
    },
  };
}
