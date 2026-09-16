/**
 * Proves the `Get-Acl`-shaped JSON parsing against captured fixture output — nothing here spawns
 * `powershell.exe`. See `../windows-powershell.ts`'s doc comment for why the command itself is
 * unmeasured, and `__tests__/windows.test.ts` for the decision logic this parsing feeds.
 */
import { describe, expect, test } from 'bun:test';
import { createCurrentWindowsUserSidReader, createWindowsAclReader } from '../windows-powershell';

describe('createWindowsAclReader', () => {
  test('parses an owner SID and a list of access rules out of the rendered PSCustomObject JSON', async () => {
    const fixture = JSON.stringify({
      DaclPresent: true, OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: [
        { Sid: 'S-1-5-21-1-2-3-1001', Rights: 'FullControl', ControlType: 'Allow' },
        { Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'Allow' },
      ],
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    await expect(reader('C:\\Users\\me\\AppData\\Local\\WTM')).resolves.toEqual({
      ownerSid: 'S-1-5-21-1-2-3-1001',
      accessRules: [
        { identitySid: 'S-1-5-21-1-2-3-1001', fileSystemRights: 'FullControl', accessControlType: 'Allow' },
        { identitySid: 'S-1-5-18', fileSystemRights: 'FullControl', accessControlType: 'Allow' },
      ],
    });
  });

  test('a single access rule serializes as one object, not a one-element array — still parses', async () => {
    // ConvertTo-Json collapses a single-element PowerShell array to a bare object unless `-AsArray`
    // is used; the parser must accept both shapes rather than assuming an array.
    const fixture = JSON.stringify({
      DaclPresent: true, OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: { Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'Allow' },
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    await expect(reader('C:\\x')).resolves.toEqual({
      ownerSid: 'S-1-5-21-1-2-3-1001',
      accessRules: [{ identitySid: 'S-1-5-18', fileSystemRights: 'FullControl', accessControlType: 'Allow' }],
    });
  });

  test('resolves undefined when the command fails (path does not exist, powershell missing, ...)', async () => {
    const reader = createWindowsAclReader(async () => { throw new Error('ItemNotFoundException'); });
    await expect(reader('C:\\missing')).resolves.toBeUndefined();
  });

  test('resolves undefined when the output is not the JSON shape expected', async () => {
    const reader = createWindowsAclReader(async () => ({ stdout: 'not json' }));
    await expect(reader('C:\\x')).resolves.toBeUndefined();

    const missingOwner = createWindowsAclReader(async () => ({ stdout: JSON.stringify({ AccessRules: [] }) }));
    await expect(missingOwner('C:\\x')).resolves.toBeUndefined();
  });

  test('a malformed individual access rule invalidates the whole ACL evidence', async () => {
    const fixture = JSON.stringify({
      DaclPresent: true, OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: [
        { Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'Allow' },
        { Rights: 'FullControl' }, // no Sid
      ],
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    await expect(reader('C:\\x')).resolves.toBeUndefined();
  });

  test('an unrecognised ControlType invalidates the entire ACL evidence', async () => {
    const fixture = JSON.stringify({
      DaclPresent: true, OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: [{ Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'SomethingElse' }],
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    const result = await reader('C:\\x');
    expect(result).toBeUndefined();
  });

  test('missing or malformed rule collections and SID evidence cannot become an empty trusted ACL', async () => {
    for (const evidence of [
      { DaclPresent: true, OwnerSid: 'S-1-5-18' },
      { DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: null },
      { DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [null] },
      { DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [42] },
      { DaclPresent: true, OwnerSid: '', AccessRules: [] },
      { DaclPresent: true, OwnerSid: 'Administrator', AccessRules: [] },
      { DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [{ Sid: '', Rights: 'FullControl', ControlType: 'Allow' }] },
      { DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [{ Sid: 'S-1-1-0', Rights: '', ControlType: 'Allow' }] },
    ]) {
      const reader = createWindowsAclReader(async () => ({ stdout: JSON.stringify(evidence) }));
      expect(await reader('C:\\x')).toBeUndefined();
    }
  });

});

describe('createWindowsAclReader command construction', () => {
  test('imports Microsoft.PowerShell.Security by its literal $PSHOME path before calling Get-Acl', async () => {
    // A real windows-latest leg proved PSModulePath-based autoload picks the wrong copy of this
    // module (PowerShell 7's, ahead of the real 5.1 one) whenever both are installed -- see
    // ../windows-powershell.ts's doc comment on `importSecurityModuleByExplicitPath`. The command
    // sent to powershell.exe must import the module by its $PSHOME-relative path itself, not rely
    // on Get-Acl's own autoload to find it.
    let capturedCommand: string | undefined;
    const reader = createWindowsAclReader(async (args) => {
      capturedCommand = args[args.indexOf('-Command') + 1];
      return { stdout: JSON.stringify({ DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [] }) };
    });
    await reader('C:\\x');
    expect(capturedCommand).toContain('Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"');
    // Every command this script names is module-qualified, and this is the only place it can be
    // pinned: the pooled session carries this script base64-encoded, so a regex over what the
    // session writes structurally cannot see it. PowerShell resolves alias before function before
    // cmdlet, and a long-lived session makes a shadowing definition permanent -- `Get-Acl` is the
    // one call whose answer *is* the trust decision, so an unqualified one must not pass review
    // with every test still green.
    expect(capturedCommand).toContain('Microsoft.PowerShell.Security\\Get-Acl -LiteralPath');
    expect(capturedCommand).toContain('Microsoft.PowerShell.Core\\ForEach-Object');
    expect(capturedCommand).toContain('Microsoft.PowerShell.Utility\\ConvertTo-Json');
    for (const command of ['Get-Acl', 'Import-Module', 'ForEach-Object', 'ConvertTo-Json']) {
      expect(`${command} unqualified: ${String(new RegExp(`(?<![\\\\])\\b${command}\\b`).test(capturedCommand ?? ''))}`)
        .toBe(`${command} unqualified: false`);
    }
    expect(capturedCommand?.indexOf('Import-Module')).toBeLessThan(capturedCommand?.indexOf('Get-Acl') ?? -1);
  });
});

describe('createCurrentWindowsUserSidReader', () => {
  test('trims the SID string powershell prints', async () => {
    const reader = createCurrentWindowsUserSidReader(async () => ({ stdout: '  S-1-5-21-1-2-3-1001  \r\n' }));
    await expect(reader()).resolves.toBe('S-1-5-21-1-2-3-1001');
  });

  test('resolves null on empty output or a failed command', async () => {
    const empty = createCurrentWindowsUserSidReader(async () => ({ stdout: '' }));
    await expect(empty()).resolves.toBeNull();

    const failed = createCurrentWindowsUserSidReader(async () => { throw new Error('boom'); });
    await expect(failed()).resolves.toBeNull();
  });

  test('spends powershell.exe once per reader, not once per call, once it has a real answer', async () => {
    let calls = 0;
    const reader = createCurrentWindowsUserSidReader(async () => {
      calls += 1;
      return { stdout: 'S-1-5-21-1-2-3-1001' };
    });
    await expect(reader()).resolves.toBe('S-1-5-21-1-2-3-1001');
    await expect(reader()).resolves.toBe('S-1-5-21-1-2-3-1001');
    await expect(reader()).resolves.toBe('S-1-5-21-1-2-3-1001');
    expect(calls).toBe(1);
  });

  test('does not cache a failed or empty resolution, so a later call can still succeed', async () => {
    let calls = 0;
    const reader = createCurrentWindowsUserSidReader(async () => {
      calls += 1;
      if (calls < 3) return { stdout: '' };
      return { stdout: 'S-1-5-21-1-2-3-1001' };
    });
    await expect(reader()).resolves.toBeNull();
    await expect(reader()).resolves.toBeNull();
    await expect(reader()).resolves.toBe('S-1-5-21-1-2-3-1001');
    expect(calls).toBe(3);
  });
});


test('invalid current-user SID output is rejected and never memoized', async () => {
  let calls = 0;
  const reader = createCurrentWindowsUserSidReader(async () => ({ stdout: ++calls === 1 ? 'permission denied' : 'S-1-5-21-1-2-3-1001' }));
  expect(await reader()).toBeNull();
  expect(await reader()).toBe('S-1-5-21-1-2-3-1001');
  expect(calls).toBe(2);
});


test('an absent or unobserved DACL cannot be confused with an empty deny-all DACL', async () => {
  for (const evidence of [
    { OwnerSid: 'S-1-5-18', AccessRules: [] },
    { DaclPresent: false, OwnerSid: 'S-1-5-18', AccessRules: [] },
    { DaclPresent: null, OwnerSid: 'S-1-5-18', AccessRules: [] },
    { DaclPresent: 'true', OwnerSid: 'S-1-5-18', AccessRules: [] },
  ]) {
    const reader = createWindowsAclReader(async () => ({ stdout: JSON.stringify(evidence) }));
    expect(await reader('C:\\x')).toBeUndefined();
  }
  const emptyDacl = createWindowsAclReader(async () => ({ stdout: JSON.stringify({ DaclPresent: true, OwnerSid: 'S-1-5-18', AccessRules: [] }) }));
  expect(await emptyDacl('C:\\x')).toEqual({ ownerSid: 'S-1-5-18', accessRules: [] });
});
