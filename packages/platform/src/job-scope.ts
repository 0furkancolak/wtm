import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { PlatformId } from './ports';

interface ScopeReaders {
  read?: (path: string) => Promise<string>;
  run?: (executable: string, argv: string[]) => Promise<string>;
  uid?: () => number | undefined;
}

class JobScopeError extends Error {
  readonly code = 'WTM_JOB_NOT_QUEUEABLE' as const;
  readonly severity = 'error' as const;
  constructor() { super('A stable local machine and user identity is required for the shared job queue.'); }
}

/**
 * Read once by the daemon. The identity is independent of shared HOME and hostname. OS images
 * must have distinct machine UUIDs (cloning an identity defeats any identity-based partition).
 * Only an application-specific digest is persisted, never the raw hardware/machine ID or SID.
 */
export async function readHeavyJobScope(platform: PlatformId, readers: ScopeReaders = {}): Promise<string> {
  const read = readers.read ?? readBounded;
  const run = readers.run ?? runBounded;
  try {
    let machine: string;
    let user: string;
    if (platform === 'win32') {
      const output: unknown = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference="Stop"; @{machine=(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID; user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress',
      ]));
      if (typeof output !== 'object' || output === null || !('machine' in output) || !('user' in output)
        || typeof output.machine !== 'string' || typeof output.user !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(output.user)) throw new JobScopeError();
      machine = normalizeMachineId(output.machine);
      user = output.user;
    } else {
      const uid = (readers.uid ?? (() => process.getuid?.()))();
      if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new JobScopeError();
      user = String(uid);
      if (platform === 'linux') {
        let raw: string;
        try { raw = await read('/etc/machine-id'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          raw = await read('/var/lib/dbus/machine-id');
        }
        machine = normalizeMachineId(raw);
      } else {
        const output = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
        const raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1];
        if (raw === undefined) throw new JobScopeError();
        machine = normalizeMachineId(raw);
      }
    }
    return `wtm-jobs-v1:${createHmac('sha256', 'wtm-heavy-job-scope-v1').update(JSON.stringify([platform, machine, user])).digest('hex')}`;
  } catch { throw new JobScopeError(); }
}

function normalizeMachineId(raw: string): string {
  const value = raw.trim().toLowerCase().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(value) || /^(?:0{32}|f{32})$/.test(value)) throw new JobScopeError();
  return value;
}
async function readBounded(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(129);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) throw new JobScopeError();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await file.close(); }
}
async function runBounded(executable: string, argv: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(executable, argv, { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true });
  return stdout;
}
