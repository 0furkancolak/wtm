/**
 * Proves the Windows `FileTrustPolicy`'s parsing and decision logic against fixture ACL data —
 * exactly what C1 did for `/proc/stat` without a Linux kernel. Nothing here runs `powershell.exe`
 * or reads a real ACL; `__tests__/windows-powershell.test.ts` covers the JSON parsing separately.
 * See `../windows.ts`'s own doc comment for why this split exists and what it does not prove.
 */
import { describe, expect, test } from 'bun:test';
import type { NodeJsStats } from '../../ports';
import {
  createWindowsFileTrustPolicy,
  windowsTrustedPrincipalSids,
  type WindowsPathAcl,
} from '../windows';

const ownerSid = 'S-1-5-21-1-2-3-1001';
const otherUserSid = 'S-1-5-21-1-2-3-1002';
const systemSid = 'S-1-5-18';

function stat(overrides: Partial<NodeJsStats> = {}): NodeJsStats {
  return { uid: 0, mode: 0, nlink: 1, ...overrides };
}

function policyWith(acl: WindowsPathAcl | undefined, currentSid: string | null = ownerSid) {
  return createWindowsFileTrustPolicy({
    readAcl: async () => acl,
    currentUserSid: async () => currentSid,
  });
}

describe('createWindowsFileTrustPolicy', () => {
  test('isOwnedByCurrentUser matches on owner SID, not account name', async () => {
    const policy = policyWith({ ownerSid, accessRules: [] });
    await expect(policy.isOwnedByCurrentUser(stat(), 'C:\\x')).resolves.toBe(true);
  });

  test('isOwnedByCurrentUser is false when the owner SID differs', async () => {
    const policy = policyWith({ ownerSid: otherUserSid, accessRules: [] });
    await expect(policy.isOwnedByCurrentUser(stat(), 'C:\\x')).resolves.toBe(false);
  });

  test('isOwnedByCurrentUser is false when the ACL cannot be read at all', async () => {
    const policy = policyWith(undefined);
    await expect(policy.isOwnedByCurrentUser(stat(), 'C:\\x')).resolves.toBe(false);
  });

  test('isOwnedByCurrentUser is false when the current user SID cannot be determined', async () => {
    const policy = policyWith({ ownerSid, accessRules: [] }, null);
    await expect(policy.isOwnedByCurrentUser(stat(), 'C:\\x')).resolves.toBe(false);
  });

  test('isOwnedByCurrentUser accepts a trusted principal as owner, not just the current user', async () => {
    for (const trustedSid of windowsTrustedPrincipalSids) {
      const policy = policyWith({ ownerSid: trustedSid, accessRules: [] });
      await expect(policy.isOwnedByCurrentUser(stat(), 'C:\\x')).resolves.toBe(true);
    }
  });

  test('0o077 (no access at all): an extra Allow rule for any non-trusted principal fails it, even read-only', async () => {
    const policy = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: otherUserSid, fileSystemRights: 'Read, Synchronize', accessControlType: 'Allow' },
      ],
    });
    await expect(policy.isWritableOnlyByOwner(stat(), 'C:\\x', 0o077)).resolves.toBe(false);
  });

  test('0o077: an owner-only ACL, or one naming only the owner and trusted principals, passes', async () => {
    const policy = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: ownerSid, fileSystemRights: 'FullControl', accessControlType: 'Allow' },
        { identitySid: systemSid, fileSystemRights: 'FullControl', accessControlType: 'Allow' },
      ],
    });
    await expect(policy.isWritableOnlyByOwner(stat(), 'C:\\x', 0o077)).resolves.toBe(true);
  });

  test('0o022 (no write): a non-trusted principal with read-only access passes, write access fails', async () => {
    const readOnly = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: otherUserSid, fileSystemRights: 'Read, Synchronize', accessControlType: 'Allow' },
      ],
    });
    await expect(readOnly.isWritableOnlyByOwner(stat(), 'C:\\x', 0o022)).resolves.toBe(true);

    const writable = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: otherUserSid, fileSystemRights: 'Modify, Synchronize', accessControlType: 'Allow' },
      ],
    });
    await expect(writable.isWritableOnlyByOwner(stat(), 'C:\\x', 0o022)).resolves.toBe(false);
  });

  test('a Deny rule never grants access, so it cannot make the check fail', async () => {
    const policy = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: otherUserSid, fileSystemRights: 'FullControl', accessControlType: 'Deny' },
      ],
    });
    await expect(policy.isWritableOnlyByOwner(stat(), 'C:\\x', 0o077)).resolves.toBe(true);
  });

  test('write-capable rights that do not literally contain "Write" (AppendData, TakeOwnership) still count', async () => {
    const policy = policyWith({
      ownerSid,
      accessRules: [
        { identitySid: otherUserSid, fileSystemRights: 'AppendData', accessControlType: 'Allow' },
      ],
    });
    await expect(policy.isWritableOnlyByOwner(stat(), 'C:\\x', 0o022)).resolves.toBe(false);
  });

  test('isNotSharedByHardLink reuses stat.nlink unchanged', () => {
    const policy = policyWith({ ownerSid, accessRules: [] });
    expect(policy.isNotSharedByHardLink(stat({ nlink: 1 }))).toBe(true);
    expect(policy.isNotSharedByHardLink(stat({ nlink: 2 }))).toBe(false);
    // Stricter than POSIX on purpose: Windows has no rename-over-a-held-descriptor race to excuse
    // zero links, and a volume that cannot report NumberOfLinks says zero for an ordinary file.
    expect(policy.isNotSharedByHardLink(stat({ nlink: 0 }))).toBe(false);
  });

  test('the trusted-principal allowlist names exactly SYSTEM and Administrators', () => {
    expect(windowsTrustedPrincipalSids).toEqual(['S-1-5-18', 'S-1-5-32-544']);
  });

  test('isExecutable answers without reading the mode or the ACL', async () => {
    // The mode Node synthesises for an ordinary Windows file, and for a read-only one. Neither
    // carries an execute bit, so a POSIX-shaped test refuses both -- which is what refused every
    // adapter executable on Windows before this predicate existed.
    const policy = policyWith({ ownerSid, accessRules: [] });
    await expect(policy.isExecutable(stat({ mode: 0o666 }), 'C:\\x')).resolves.toBe(true);
    await expect(policy.isExecutable(stat({ mode: 0o444 }), 'C:\\x')).resolves.toBe(true);

    // And no ACL read: an unreadable ACL is what every other predicate fails closed on, so
    // answering from one would make executability fail closed for the same reasons and put the
    // cost of a powershell.exe round trip behind a question NTFS does not record.
    let aclReads = 0;
    const counting = createWindowsFileTrustPolicy({
      readAcl: async () => {
        aclReads += 1;
        return undefined;
      },
      currentUserSid: async () => ownerSid,
    });
    await expect(counting.isExecutable(stat(), 'C:\\x')).resolves.toBe(true);
    expect(aclReads).toBe(0);
  });
});


test('unknown and numeric ACE rights never count as proven read-only access', async () => {
  for (const rights of ['2', '-1', 'UnexpectedRight', 'Read, UnexpectedRight', '']) {
    const policy = policyWith({ ownerSid, accessRules: [{ identitySid: otherUserSid, fileSystemRights: rights, accessControlType: 'Allow' }] });
    expect(await policy.isWritableOnlyByOwner(stat(), 'C:\\x', 0o022)).toBe(false);
  }
});
