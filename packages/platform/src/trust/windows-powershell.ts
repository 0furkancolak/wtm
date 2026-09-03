/**
 * The default `WindowsAclReader`/`CurrentWindowsUserSidReader`: `powershell.exe` (Windows
 * PowerShell 5.1, present on every supported Windows version and on `windows-latest` GitHub
 * runners without an install step — not the separately-installed PowerShell 7 `pwsh`), asked for
 * structured JSON rather than `icacls`'s locale-dependent text table.
 *
 * `execFile`'s `timeout` sends `killSignal` once the deadline passes and otherwise keeps waiting
 * for the child — Increment C3 (`2026-09-03-a-hang-that-cannot-hide.md`) measured that a child
 * which ignores the default `SIGTERM` makes the call block indefinitely. `killSignal: 'SIGKILL'`
 * is set explicitly here for the same reason C3 set it on every scenario child: a call that has
 * already blown its deadline loses nothing by being denied a graceful exit.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CurrentWindowsUserSidReader, WindowsAccessRule, WindowsAclReader, WindowsPathAcl } from './windows';

const execFileAsync = promisify(execFile);

const powershellTimeoutMs = 5_000;

export type PowershellRunner = (args: readonly string[]) => Promise<{ stdout: string }>;

const defaultRunPowershell: PowershellRunner = async (args) =>
  await execFileAsync('powershell.exe', [...args], {
    encoding: 'utf8',
    timeout: powershellTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });

interface RawAccessRule {
  Sid?: unknown;
  Rights?: unknown;
  ControlType?: unknown;
}

interface RawPathAcl {
  OwnerSid?: unknown;
  AccessRules?: unknown;
}

/**
 * Builds the owner SID and every access rule into one `PSCustomObject`, translated to a SID
 * up front — a `Get-Acl` object's raw `.Access`/`.Owner` serialize as display names by default,
 * which C1's own reasoning for macOS `ps` argument vectors applies here too: a value this code
 * has to parse should already be in the form the parser expects, not reshaped by a second layer.
 */
function aclScript(path: string): string {
  const escaped = path.replace(/'/g, "''");
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$acl = Get-Acl -LiteralPath '${escaped}'`,
    `$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`,
    `$rules = $acl.Access | ForEach-Object {`,
    `  $sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value }`,
    `  [PSCustomObject]@{ Sid = $sid; Rights = $_.FileSystemRights.ToString(); ControlType = $_.AccessControlType.ToString() }`,
    `}`,
    `[PSCustomObject]@{ OwnerSid = $owner; AccessRules = @($rules) } | ConvertTo-Json -Depth 5 -Compress`,
  ].join('; ');
}

function parseAccessRule(raw: RawAccessRule): WindowsAccessRule | undefined {
  if (typeof raw.Sid !== 'string' || typeof raw.Rights !== 'string') return undefined;
  const controlType = raw.ControlType === 'Deny' ? 'Deny' : 'Allow';
  return { identitySid: raw.Sid, fileSystemRights: raw.Rights, accessControlType: controlType };
}

function parsePathAcl(stdout: string): WindowsPathAcl | undefined {
  let raw: RawPathAcl;
  try {
    raw = JSON.parse(stdout) as RawPathAcl;
  } catch {
    return undefined;
  }
  if (typeof raw.OwnerSid !== 'string') return undefined;
  const rawRules = Array.isArray(raw.AccessRules) ? raw.AccessRules : [raw.AccessRules];
  const accessRules = (rawRules as RawAccessRule[])
    .filter((entry): entry is RawAccessRule => entry !== null && typeof entry === 'object')
    .map(parseAccessRule)
    .filter((rule): rule is WindowsAccessRule => rule !== undefined);
  return { ownerSid: raw.OwnerSid, accessRules };
}

export function createWindowsAclReader(runPowershell: PowershellRunner = defaultRunPowershell): WindowsAclReader {
  return async (path) => {
    try {
      const { stdout } = await runPowershell(['-NoProfile', '-NonInteractive', '-Command', aclScript(path)]);
      return parsePathAcl(stdout);
    } catch {
      return undefined;
    }
  };
}

export function createCurrentWindowsUserSidReader(
  runPowershell: PowershellRunner = defaultRunPowershell,
): CurrentWindowsUserSidReader {
  return async () => {
    try {
      const { stdout } = await runPowershell([
        '-NoProfile', '-NonInteractive', '-Command',
        '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      ]);
      const sid = stdout.trim();
      return sid.length > 0 ? sid : null;
    } catch {
      return null;
    }
  };
}
