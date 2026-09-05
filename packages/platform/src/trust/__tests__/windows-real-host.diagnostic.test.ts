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
 * Round four: three real `windows-latest` legs in a row -- the retry (a7549ac), the
 * `PSModuleAnalysisCachePath=NUL` fix (090b46b), and this file's own round-three evidence -- have
 * now shown the failure is not transient and not concurrency-dependent at all: five *sequential*
 * `readAcl` calls, the very first things this test does with nothing else running, all failed
 * identically with `CouldNotAutoloadMatchingModule`. That rules out every contention-based
 * hypothesis this investigation has tried so far. What is left to check is whether the module
 * genuinely cannot load on this runner at all -- a broken `PSModulePath`, a missing module
 * directory, or a runner-image-level regression -- which this probes directly rather than
 * guessing a fourth fix. Delete this file once that question has a real answer.
 */
(process.platform === 'win32' ? describe : describe.skip)('real Windows ACL read, diagnostic', () => {
  test('reports why Microsoft.PowerShell.Security will not load at all on this host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-acl-diagnostic-'));
    try {
      const readAcl = createWindowsAclReader();
      const currentUserSid = createCurrentWindowsUserSidReader();

      const sid = await currentUserSid();
      console.error('[wtm-acl-diagnostic] directory:', directory);
      console.error('[wtm-acl-diagnostic] currentUserSid:', JSON.stringify(sid));
      console.error('[wtm-acl-diagnostic] trustedPrincipalSids:', JSON.stringify(windowsTrustedPrincipalSids));

      const acl = await readAcl(directory);
      console.error('[wtm-acl-diagnostic] readAcl:', JSON.stringify(acl));

      async function probe(label: string, command: string): Promise<void> {
        try {
          const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 5000 });
          console.error(`[wtm-acl-diagnostic] ${label} stdout:`, JSON.stringify(result.stdout));
          console.error(`[wtm-acl-diagnostic] ${label} stderr:`, JSON.stringify(result.stderr));
        } catch (error) {
          console.error(`[wtm-acl-diagnostic] ${label} THREW:`, String(error));
          console.error(`[wtm-acl-diagnostic] ${label} THREW stdout/stderr:`, JSON.stringify((error as { stdout?: string; stderr?: string }).stdout), JSON.stringify((error as { stdout?: string; stderr?: string }).stderr));
        }
      }

      await probe('PSVersionTable', '$PSVersionTable | ConvertTo-Json -Compress');
      await probe('PSModulePath', '$env:PSModulePath');
      await probe('Get-Module -ListAvailable Security', "Get-Module -ListAvailable -Name Microsoft.PowerShell.Security | ConvertTo-Json -Compress");
      await probe('module directory listing', "Get-ChildItem -Path (\"$PSHOME\\Modules\\Microsoft.PowerShell.Security\") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name");
      await probe('explicit Import-Module -Force -Verbose', 'Import-Module Microsoft.PowerShell.Security -Force -Verbose 4>&1 | Out-String');
      await probe('Import-Module by explicit full path', "Import-Module -Name \"$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1\" -Force -Verbose 4>&1 | Out-String");

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
