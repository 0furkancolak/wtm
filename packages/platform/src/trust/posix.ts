/**
 * The POSIX `FileTrustPolicy`: the inline `uid`/`mode`/`nlink` checks that were scattered across
 * 11 files in `@wtm/core`, moved here unchanged (spec `2026-09-03-windows-trust-and-transport-seam.md`,
 * D2). Every predicate is exactly the comparison the call site it replaces already made — this file
 * adds no new logic, because the entire point of the move is that macOS and Linux behaviour is
 * byte-identical afterwards, proven by every migrated file's existing tests passing unmodified.
 */
import type { FileTrustPolicy, NodeJsStats, OwnerOnlyMask } from '../ports';

export const posixFileTrustPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser(stat: NodeJsStats, _path: string): Promise<boolean> {
    const currentUid = process.getuid?.();
    return Promise.resolve(currentUid !== undefined && stat.uid === currentUid);
  },

  isWritableOnlyByOwner(stat: NodeJsStats, _path: string, mask: OwnerOnlyMask): Promise<boolean> {
    return Promise.resolve((stat.mode & mask) === 0);
  },

  /**
   * `nlink > 1` is the only shape that means "another name points at this inode". `nlink === 0`
   * is an `fstat` of a descriptor whose last directory entry has already been removed — an
   * anonymous, unreachable inode that no second name can reach, so it is the opposite of shared.
   * Reading it as unsafe is what made a managed log reader refuse a generation marker it had
   * opened microseconds before the anchor's rotation renamed a replacement over it, and turned a
   * bounded retry into a hard `Unsafe managed log target` failure on macOS CI.
   */
  isNotSharedByHardLink(stat: NodeJsStats): boolean {
    return stat.nlink <= 1;
  },

  currentIdentityAvailable(): boolean {
    return process.getuid?.() !== undefined;
  },
};
