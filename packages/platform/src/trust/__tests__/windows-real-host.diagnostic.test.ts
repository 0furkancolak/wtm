import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCurrentWindowsUserSidReader, createWindowsAclReader } from '../windows-powershell';
import { createWindowsFileTrustPolicy, windowsTrustedPrincipalSids } from '../windows';

const execFileAsync = promisify(execFile);

/**
 * Not part of D2's normal suite: a one-shot, real-`powershell.exe` probe against a directory this
 * process just created, kept only until a real `windows-latest` leg explains why
 * `secureDirectory`'s `isOwnedByCurrentUser` check keeps failing there. The first version of this
 * file (still in git history) proved `readAcl()` itself resolves `undefined` -- the swallowed
 * exception inside `createWindowsAclReader`'s try/catch, not an owner-SID mismatch as first
 * suspected. This version bypasses that swallowing to show the raw stdout/stderr/exit code/thrown
 * error underneath it. Delete this file once that question has a real answer.
 */
(process.platform === 'win32' ? describe : describe.skip)('real Windows ACL read, diagnostic', () => {
  test('reports what Get-Acl and WindowsIdentity actually say about a directory this process just made', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-acl-diagnostic-'));
    try {
      // 1. The exact high-level reader used in production, whose result we already know.
      const readAcl = createWindowsAclReader();
      const currentUserSid = createCurrentWindowsUserSidReader();
      const [acl, sid] = await Promise.all([readAcl(directory), currentUserSid()]);
      console.error('[wtm-acl-diagnostic] directory:', directory);
      console.error('[wtm-acl-diagnostic] currentUserSid:', JSON.stringify(sid));
      console.error('[wtm-acl-diagnostic] acl (high-level reader):', JSON.stringify(acl));

      // 2. The rawest possible powershell.exe invocation: does the binary even run at all here?
      try {
        const trivial = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output hello'], { encoding: 'utf8', timeout: 5000 });
        console.error('[wtm-acl-diagnostic] trivial powershell stdout:', JSON.stringify(trivial.stdout));
        console.error('[wtm-acl-diagnostic] trivial powershell stderr:', JSON.stringify(trivial.stderr));
      } catch (error) {
        console.error('[wtm-acl-diagnostic] trivial powershell THREW:', String(error));
      }

      // 3. The exact Get-Acl script this port runs, but with stderr and the raw exception surfaced
      // instead of swallowed, against the same directory the high-level reader just failed on.
      const escaped = directory.replace(/'/g, "''");
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `$acl = Get-Acl -LiteralPath '${escaped}'`,
        `$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
        `$rules = $acl.Access | ForEach-Object {`,
        `  $ruleSid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value }`,
        `  [PSCustomObject]@{ Sid = $ruleSid; Rights = $_.FileSystemRights.ToString(); ControlType = $_.AccessControlType.ToString() }`,
        `}`,
        `[PSCustomObject]@{ OwnerSid = $owner; AccessRules = @($rules) } | ConvertTo-Json -Depth 5 -Compress`,
      ].join('; ');
      try {
        const raw = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 5000 });
        console.error('[wtm-acl-diagnostic] raw Get-Acl stdout:', JSON.stringify(raw.stdout));
        console.error('[wtm-acl-diagnostic] raw Get-Acl stderr:', JSON.stringify(raw.stderr));
      } catch (error) {
        console.error('[wtm-acl-diagnostic] raw Get-Acl THREW:', String(error));
        console.error('[wtm-acl-diagnostic] raw Get-Acl THREW (stdout/stderr if any):', JSON.stringify((error as { stdout?: string; stderr?: string }).stdout), JSON.stringify((error as { stdout?: string; stderr?: string }).stderr));
      }

      console.error('[wtm-acl-diagnostic] trustedPrincipalSids:', JSON.stringify(windowsTrustedPrincipalSids));
      const policy = createWindowsFileTrustPolicy({ readAcl, currentUserSid });
      const stat = { uid: 0, mode: 0, nlink: 1 };
      const owned = await policy.isOwnedByCurrentUser(stat, directory);
      console.error('[wtm-acl-diagnostic] isOwnedByCurrentUser result:', owned);

      // Loose on purpose: the point of this file is the console.error output above landing in a
      // real CI log, not a pass/fail verdict.
      expect(acl !== undefined || sid !== null).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
