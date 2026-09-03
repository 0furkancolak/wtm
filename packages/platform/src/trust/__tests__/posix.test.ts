import { describe, expect, test } from 'bun:test';
import type { NodeJsStats } from '../../ports';
import { posixFileTrustPolicy } from '../posix';

function stat(overrides: Partial<NodeJsStats>): NodeJsStats {
  return { uid: 0, mode: 0o700, nlink: 1, ...overrides };
}

describe('posixFileTrustPolicy', () => {
  test('isOwnedByCurrentUser is true only when stat.uid matches the real current uid', async () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) throw new Error('this suite requires process.getuid()');
    await expect(posixFileTrustPolicy.isOwnedByCurrentUser(stat({ uid: currentUid }), '/x')).resolves.toBe(true);
    await expect(posixFileTrustPolicy.isOwnedByCurrentUser(stat({ uid: currentUid + 1 }), '/x')).resolves.toBe(false);
  });

  test('isWritableOnlyByOwner applies exactly the mask it is given, not a fixed one', async () => {
    // 0o022: no group/other *write*. Group-read-only (0o740) still satisfies it.
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o740 }), '/x', 0o022)).resolves.toBe(true);
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o722 }), '/x', 0o022)).resolves.toBe(false);
    // 0o077: no group/other access at all. The same 0o740 now fails it.
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o740 }), '/x', 0o077)).resolves.toBe(false);
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o700 }), '/x', 0o077)).resolves.toBe(true);
  });

  test('isNotSharedByHardLink is exactly stat.nlink === 1', () => {
    expect(posixFileTrustPolicy.isNotSharedByHardLink(stat({ nlink: 1 }))).toBe(true);
    expect(posixFileTrustPolicy.isNotSharedByHardLink(stat({ nlink: 2 }))).toBe(false);
  });

  test('currentIdentityAvailable reflects whether process.getuid() answers at all', () => {
    expect(posixFileTrustPolicy.currentIdentityAvailable()).toBe(process.getuid?.() !== undefined);
  });
});
