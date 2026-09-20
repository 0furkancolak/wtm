import { describe, expect, test } from 'bun:test';
import type { NodeJsStats } from '../../ports';
import { posixFileTrustPolicy } from '../posix';

function stat(overrides: Partial<NodeJsStats>): NodeJsStats {
  return { uid: 0, mode: 0o700, nlink: 1, ...overrides };
}

describe('posixFileTrustPolicy', () => {
  // `process.getuid()` is undefined on Windows: there is no real uid for this test to compare
  // stat.uid against, and `posixFileTrustPolicy` is the POSIX (darwin/linux) backend anyway —
  // the same reasoning `darwin-process.test.ts`'s "against this machine" block and
  // `launchd.test.ts`'s plutil check use for a test whose premise needs a capability this host
  // may not have.
  test.skipIf(process.getuid === undefined)(
    'isOwnedByCurrentUser is true only when stat.uid matches the real current uid',
    async () => {
      const currentUid = process.getuid?.();
      if (currentUid === undefined) throw new Error('this suite requires process.getuid()');
      await expect(posixFileTrustPolicy.isOwnedByCurrentUser(stat({ uid: currentUid }), '/x')).resolves.toBe(true);
      await expect(posixFileTrustPolicy.isOwnedByCurrentUser(stat({ uid: currentUid + 1 }), '/x')).resolves.toBe(false);
    },
  );

  test('isWritableOnlyByOwner applies exactly the mask it is given, not a fixed one', async () => {
    // 0o022: no group/other *write*. Group-read-only (0o740) still satisfies it.
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o740 }), '/x', 0o022)).resolves.toBe(true);
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o722 }), '/x', 0o022)).resolves.toBe(false);
    // 0o077: no group/other access at all. The same 0o740 now fails it.
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o740 }), '/x', 0o077)).resolves.toBe(false);
    await expect(posixFileTrustPolicy.isWritableOnlyByOwner(stat({ mode: 0o700 }), '/x', 0o077)).resolves.toBe(true);
  });

  test('isNotSharedByHardLink refuses a second name and accepts an already-unlinked inode', () => {
    expect(posixFileTrustPolicy.isNotSharedByHardLink(stat({ nlink: 1 }))).toBe(true);
    expect(posixFileTrustPolicy.isNotSharedByHardLink(stat({ nlink: 2 }))).toBe(false);
    // An `fstat` of a descriptor whose last name was renamed away reports zero links. Nothing can
    // reach that inode any more, so it is not shared; refusing it turned a managed log reader's
    // bounded rotation retry into an outright refusal.
    expect(posixFileTrustPolicy.isNotSharedByHardLink(stat({ nlink: 0 }))).toBe(true);
  });

  test('currentIdentityAvailable reflects whether process.getuid() answers at all', () => {
    expect(posixFileTrustPolicy.currentIdentityAvailable()).toBe(process.getuid?.() !== undefined);
  });

  test('isExecutable accepts any execute bit, not the owner\'s alone', async () => {
    await expect(posixFileTrustPolicy.isExecutable(stat({ mode: 0o700 }), '/x')).resolves.toBe(true);
    // Group- and other-execute count: the kernel will run the file for someone, which is the
    // question this predicate asks. The narrower owner-only reading belongs to
    // `assertPrivateExecutionFile`, which is a different check and stays out of this port.
    await expect(posixFileTrustPolicy.isExecutable(stat({ mode: 0o610 }), '/x')).resolves.toBe(true);
    await expect(posixFileTrustPolicy.isExecutable(stat({ mode: 0o601 }), '/x')).resolves.toBe(true);
    await expect(posixFileTrustPolicy.isExecutable(stat({ mode: 0o600 }), '/x')).resolves.toBe(false);
    // The mode Node synthesises for an ordinary file on Windows. The POSIX backend says no, which
    // is exactly why the Windows backend must answer this question itself rather than share this
    // implementation -- and why core's fallback refuses everything there.
    await expect(posixFileTrustPolicy.isExecutable(stat({ mode: 0o666 }), '/x')).resolves.toBe(false);
  });
});
