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
  });

  test('the trusted-principal allowlist names exactly SYSTEM and Administrators', () => {
    expect(windowsTrustedPrincipalSids).toEqual(['S-1-5-18', 'S-1-5-32-544']);
  });
});
