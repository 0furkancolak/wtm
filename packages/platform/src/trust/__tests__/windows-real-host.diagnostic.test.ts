import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCurrentWindowsUserSidReader, createWindowsAclReader } from '../windows-powershell';
import { createWindowsFileTrustPolicy, windowsTrustedPrincipalSids } from '../windows';

/**
 * Not part of D2's normal suite: a one-shot, real-`powershell.exe` probe against a directory this
 * process just created, kept only until a real `windows-latest` leg explains why
 * `secureDirectory`'s `isOwnedByCurrentUser` check keeps failing there despite the ownership fix in
 * `../windows.ts`. `windows.test.ts`/`windows-powershell.test.ts` only prove decision logic against
 * fixture data — this is the first thing in the tree that actually shells to `powershell.exe` and
 * reports what it gets back. Delete this file once that question has a real answer.
 */
(process.platform === 'win32' ? describe : describe.skip)('real Windows ACL read, diagnostic', () => {
  test('reports what Get-Acl and WindowsIdentity actually say about a directory this process just made', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-acl-diagnostic-'));
    try {
      const readAcl = createWindowsAclReader();
      const currentUserSid = createCurrentWindowsUserSidReader();
      const [acl, sid] = await Promise.all([readAcl(directory), currentUserSid()]);

      console.error('[wtm-acl-diagnostic] directory:', directory);
      console.error('[wtm-acl-diagnostic] currentUserSid:', JSON.stringify(sid));
      console.error('[wtm-acl-diagnostic] acl:', JSON.stringify(acl));
      console.error('[wtm-acl-diagnostic] trustedPrincipalSids:', JSON.stringify(windowsTrustedPrincipalSids));

      const policy = createWindowsFileTrustPolicy({ readAcl, currentUserSid });
      const stat = { uid: 0, mode: 0, nlink: 1 };
      const owned = await policy.isOwnedByCurrentUser(stat, directory);
      console.error('[wtm-acl-diagnostic] isOwnedByCurrentUser result:', owned);

      // Loose on purpose: the point of this file is the console.error output above landing in a
      // real CI log, not a pass/fail verdict. Still asserts the two reads that matter did not both
      // silently fail, so a totally broken powershell invocation shows up as a failing assertion
      // rather than a quietly "successful" no-op test.
      expect(acl !== undefined || sid !== null).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
