/**
 * Proves the `Get-Acl`-shaped JSON parsing against captured fixture output — nothing here spawns
 * `powershell.exe`. See `../windows-powershell.ts`'s doc comment for why the command itself is
 * unmeasured, and `__tests__/windows.test.ts` for the decision logic this parsing feeds.
 */
import { describe, expect, test } from 'bun:test';
import { createCurrentWindowsUserSidReader, createWindowsAclReader, withModuleLoadRetry } from '../windows-powershell';

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

describe('withModuleLoadRetry', () => {
  // A real windows-latest CI leg observed `Get-Acl` fail with this exact PowerShell 5.1 error when
  // many `powershell.exe` processes started at once raced on the module autoload cache -- see
  // ../windows-powershell.ts's doc comment on `isTransientModuleLoadFailure`.
  const transientError = Object.assign(new Error('Command failed: powershell.exe ...'), {
    stderr: "Get-Acl : The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', "
      + 'but the module could not be loaded.\n    + FullyQualifiedErrorId : CouldNotAutoloadMatchingModule',
  });

  test('retries a transient module-autoload failure and returns the eventual success', async () => {
    let calls = 0;
    const runner = withModuleLoadRetry(async () => {
      calls += 1;
      if (calls < 2) throw transientError;
      return { stdout: 'ok' };
    });
    await expect(runner(['-Command', 'noop'])).resolves.toEqual({ stdout: 'ok' });
    expect(calls).toBe(2);
  });

  test('gives up after exhausting its retry budget, still failing with a transient error', async () => {
    let calls = 0;
    const runner = withModuleLoadRetry(async () => {
      calls += 1;
      throw transientError;
    });
    await expect(runner(['-Command', 'noop'])).rejects.toBe(transientError);
    expect(calls).toBe(3);
  });

  test('does not retry a failure unrelated to the module-autoload race', async () => {
    const nonTransient = new Error('ItemNotFoundException');
    let calls = 0;
    const runner = withModuleLoadRetry(async () => {
      calls += 1;
      throw nonTransient;
    });
    await expect(runner(['-Command', 'noop'])).rejects.toBe(nonTransient);
    expect(calls).toBe(1);
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
