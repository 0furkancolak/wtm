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

// A cold `powershell.exe` genuinely costs on the order of a second to start and import
// `Microsoft.PowerShell.Security` (measured on a real `windows-latest` runner while diagnosing
// 1d6bcd1) -- under CI-level contention (many of these processes starting at once) that can spike
// well past a couple of seconds without the call actually being stuck. 5s cut two of those spikes
// off mid-flight on a real leg and surfaced as a false "Unsafe managed log directory". 15s stays a
// bounded wait, honoring C3's hang-prevention intent, while giving real contention room to clear.
const powershellTimeoutMs = 15_000;

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
 * `Get-Acl` lives in the `Microsoft.PowerShell.Security` module, which Windows PowerShell 5.1
 * autoloads on first use by searching `$env:PSModulePath` for a module exporting that command --
 * and a real `windows-latest` leg proved that search picks the wrong copy. That host also has
 * PowerShell 7 installed, whose own `Microsoft.PowerShell.Security` (version 7.0.0.0, `Core`
 * edition) sits in a `PSModulePath` entry ahead of the real 5.1 module
 * (`$PSHOME\Modules\Microsoft.PowerShell.Security`, version 3.0.0.0, `Desktop` edition). 5.1's
 * autoloader finds the PS7 copy first and tries to load its extended type data into a 5.1 session
 * that already carries its own built-in `ObjectSecurity` type data (`Access`, `Owner`, `Sddl`, ...)
 * -- the two collide (each member "is already present"), the module load fails with
 * `FormatXmlUpdateException`, and PowerShell reports the failure up as
 * `CouldNotAutoloadMatchingModule` for *any* command in that module, `Get-Acl` included. This is
 * deterministic, not a race: it reproduced identically across purely sequential calls with nothing
 * else running (which is also why the retry and the `PSModuleAnalysisCachePath` fix an earlier
 * round of this investigation tried both landed on a real CI leg without changing anything -- ruled
 * out here rather than described, see this file's git history for that evidence). The fix is to
 * stop relying on `PSModulePath` search at all: importing the module by its literal `$PSHOME`-
 * relative path names the real 5.1 copy directly, the same way the diagnostic that found this
 * proved works, regardless of what else is installed on the host or how it orders `PSModulePath`.
 */
function importSecurityModuleByExplicitPath(): string {
  return `Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"`;
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
    importSecurityModuleByExplicitPath(),
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
