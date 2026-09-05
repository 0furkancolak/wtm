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
      OwnerSid: 'S-1-5-21-1-2-3-1001',
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
      OwnerSid: 'S-1-5-21-1-2-3-1001',
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

  test('a malformed individual access rule is dropped rather than failing the whole read', async () => {
    const fixture = JSON.stringify({
      OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: [
        { Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'Allow' },
        { Rights: 'FullControl' }, // no Sid
      ],
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    await expect(reader('C:\\x')).resolves.toEqual({
      ownerSid: 'S-1-5-21-1-2-3-1001',
      accessRules: [{ identitySid: 'S-1-5-18', fileSystemRights: 'FullControl', accessControlType: 'Allow' }],
    });
  });

  test('an unrecognised ControlType is treated as Allow-only-if-explicitly-Deny, i.e. defaults to Allow', async () => {
    const fixture = JSON.stringify({
      OwnerSid: 'S-1-5-21-1-2-3-1001',
      AccessRules: [{ Sid: 'S-1-5-18', Rights: 'FullControl', ControlType: 'SomethingElse' }],
    });
    const reader = createWindowsAclReader(async () => ({ stdout: fixture }));
    const result = await reader('C:\\x');
    expect(result?.accessRules[0]?.accessControlType).toBe('Allow');
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
      return { stdout: JSON.stringify({ OwnerSid: 'S-1-5-18', AccessRules: [] }) };
    });
    await reader('C:\\x');
    expect(capturedCommand).toContain('Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"');
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
});
