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

  isNotSharedByHardLink(stat: NodeJsStats): boolean {
    return stat.nlink === 1;
  },

  currentIdentityAvailable(): boolean {
    return process.getuid?.() !== undefined;
  },
};
