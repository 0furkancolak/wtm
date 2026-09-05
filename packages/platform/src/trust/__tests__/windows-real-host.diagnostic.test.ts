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
 * Round three: the retry (a7549ac) and the `PSModuleAnalysisCachePath=NUL` fix (090b46b) both
 * landed on a real `windows-latest` leg without changing the failure count or shape at all, which
 * means neither guess actually reached the real cause. This probes the exact same question the
 * first diagnostic (in git history) was deleted for answering too early: does `Get-Acl` still
 * throw `CouldNotAutoloadMatchingModule` under the NUL fix, or does it now succeed and return an
 * owner SID this policy simply does not recognise as trusted? Runs the real reader several times
 * in a loop (not once) because the earlier hypothesis was that contention needs concurrent
 * processes to reproduce -- a lone sequential probe in its own describe block proves nothing about
 * that even if it happens to pass. Delete this file once that question has a real answer.
 */
(process.platform === 'win32' ? describe : describe.skip)('real Windows ACL read, diagnostic', () => {
  test('reports what Get-Acl and WindowsIdentity actually say, across several sequential and concurrent attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-acl-diagnostic-'));
    try {
      const readAcl = createWindowsAclReader();
      const currentUserSid = createCurrentWindowsUserSidReader();

      const sid = await currentUserSid();
      console.error('[wtm-acl-diagnostic] directory:', directory);
      console.error('[wtm-acl-diagnostic] currentUserSid:', JSON.stringify(sid));
      console.error('[wtm-acl-diagnostic] trustedPrincipalSids:', JSON.stringify(windowsTrustedPrincipalSids));

      // Sequential attempts through the real, NUL-cache-fixed reader: does it fail every time, or
      // only sometimes? A consistent failure points at ownership, not autoload contention.
      for (let i = 0; i < 5; i += 1) {
        const acl = await readAcl(directory);
        console.error(`[wtm-acl-diagnostic] sequential readAcl attempt ${i}:`, JSON.stringify(acl));
      }

      // Concurrent attempts: the failure mode this session's whole investigation has assumed needs
      // many powershell.exe processes racing at once. Reproduce that directly, in-process.
      const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => readAcl(directory)
        .then((result) => ({ i, result }))
        .catch((error: unknown) => ({ i, error: String(error) }))));
      for (const outcome of concurrent) console.error('[wtm-acl-diagnostic] concurrent readAcl:', JSON.stringify(outcome));

      // The rawest possible powershell.exe invocation, bypassing every layer of this port, with
      // stderr and the thrown error surfaced instead of swallowed.
      const escaped = directory.replace(/'/g, "''");
      const script = [
        `$ErrorActionPreference = 'Stop'`,
        `$acl = Get-Acl -LiteralPath '${escaped}'`,
        `$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
        `[PSCustomObject]@{ OwnerSid = $owner } | ConvertTo-Json -Compress`,
      ].join('; ');
      try {
        const raw = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8', timeout: 5000, env: { ...process.env, PSModuleAnalysisCachePath: 'NUL' },
        });
        console.error('[wtm-acl-diagnostic] raw Get-Acl (NUL cache) stdout:', JSON.stringify(raw.stdout));
        console.error('[wtm-acl-diagnostic] raw Get-Acl (NUL cache) stderr:', JSON.stringify(raw.stderr));
      } catch (error) {
        console.error('[wtm-acl-diagnostic] raw Get-Acl (NUL cache) THREW:', String(error));
        console.error('[wtm-acl-diagnostic] raw Get-Acl (NUL cache) THREW stdout/stderr:', JSON.stringify((error as { stdout?: string; stderr?: string }).stdout), JSON.stringify((error as { stdout?: string; stderr?: string }).stderr));
      }

      const policy = createWindowsFileTrustPolicy({ readAcl, currentUserSid });
      const stat = { uid: 0, mode: 0, nlink: 1 };
      const owned = await policy.isOwnedByCurrentUser(stat, directory);
      console.error('[wtm-acl-diagnostic] isOwnedByCurrentUser result:', owned);

      // Loose on purpose: the point of this file is the console.error output above landing in a
      // real CI log, not a pass/fail verdict.
      expect(sid !== null).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
