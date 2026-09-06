import { describe, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCurrentWindowsUserSidReader, createWindowsAclReader, createWindowsFileTrustPolicy, windowsTrustedPrincipalSids } from '@wtm/platform';

/**
 * A real `windows-latest` leg surfaced `LOG_SETUP_FAILED`/`Unsafe managed log directory` from
 * `logs.ts`'s `secureDirectory`/`secureChildDirectory` -- real `Get-Acl`-backed trust checks
 * rejecting a directory this same process just created under `os.tmpdir()`, mode `0o700`. D2
 * already found and fixed one such rejection (ownership landing on `S-1-5-32-544` instead of the
 * process's own SID, `windows.ts`'s `isOwnedByCurrentUser`) -- this could be that same class of
 * gap in `isWritableOnlyByOwner` instead: an ACE inherited from `%TEMP%` itself, granted to a
 * principal neither the owner nor `windowsTrustedPrincipalSids`, that `0o077`'s "no access at all
 * for anyone else" mask has never been measured against on a real host. Guessing which principal
 * and rewriting the mask/trusted-set blind would repeat the mistake two earlier rounds of the
 * PowerShell investigation made; this prints the actual `Get-Acl` JSON instead. Delete once that
 * question has a real answer.
 */
(process.platform === 'win32' ? describe : describe.skip)('real Windows log-directory ACL, diagnostic', () => {
  test('reports the real ACL of a directory tree shaped like logs.ts secureDirectory/secureChildDirectory', async () => {
    const readAcl = createWindowsAclReader();
    const currentUserSid = createCurrentWindowsUserSidReader();
    const fileTrust = createWindowsFileTrustPolicy({ readAcl, currentUserSid });

    const sid = await currentUserSid();
    console.error('[wtm-log-dir-diagnostic] currentUserSid:', JSON.stringify(sid));
    console.error('[wtm-log-dir-diagnostic] trustedPrincipalSids:', JSON.stringify(windowsTrustedPrincipalSids));

    const tmp = tmpdir();
    const tmpAcl = await readAcl(tmp);
    console.error('[wtm-log-dir-diagnostic] os.tmpdir() itself:', tmp, JSON.stringify(tmpAcl));

    const root = await mkdtemp(join(tmp, 'wtm-log-diag-'));
    const rootAcl = await readAcl(root);
    console.error('[wtm-log-dir-diagnostic] mkdtemp root:', root, JSON.stringify(rootAcl));

    // Exactly `secureDirectory`'s own mkdir call: recursive, mode 0o700.
    const managedRoot = join(root, 'managed-logs');
    await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    const managedRootAcl = await readAcl(managedRoot);
    console.error('[wtm-log-dir-diagnostic] secureDirectory-shaped mkdir(recursive, 0o700):', managedRoot, JSON.stringify(managedRootAcl));
    console.error(
      '[wtm-log-dir-diagnostic] isOwnedByCurrentUser on it:',
      await fileTrust.isOwnedByCurrentUser({} as never, managedRoot),
    );
    console.error(
      '[wtm-log-dir-diagnostic] isWritableOnlyByOwner(0o077) on it:',
      await fileTrust.isWritableOnlyByOwner({} as never, managedRoot, 0o077),
    );

    // Exactly `secureChildDirectory`'s own mkdir call: non-recursive, mode 0o700.
    const child = join(managedRoot, 'worktree-1');
    await mkdir(child, { mode: 0o700 });
    const childAcl = await readAcl(child);
    console.error('[wtm-log-dir-diagnostic] secureChildDirectory-shaped mkdir(0o700):', child, JSON.stringify(childAcl));
    console.error(
      '[wtm-log-dir-diagnostic] isOwnedByCurrentUser on it:',
      await fileTrust.isOwnedByCurrentUser({} as never, child),
    );
    console.error(
      '[wtm-log-dir-diagnostic] isWritableOnlyByOwner(0o077) on it:',
      await fileTrust.isWritableOnlyByOwner({} as never, child, 0o077),
    );
  }, 30_000);
});
