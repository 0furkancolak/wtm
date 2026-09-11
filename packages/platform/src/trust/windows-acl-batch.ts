import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parseWindowsPathAcl } from './windows-powershell';
import type { WindowsPathAcl } from './windows';

const maxPaths = 128;
const maxInputBytes = 64 * 1024;
const maxOutputBytes = 1024 * 1024;
const timeoutMs = 15_000;

export interface WindowsAclBatch {
  readonly currentSid: string;
  readonly acls: ReadonlyMap<string, WindowsPathAcl>;
}

export interface WindowsAclBatchOptions {
  readonly signal?: AbortSignal;
  /** Test seam; the production reader always starts a fresh, bounded PowerShell process. */
  readonly run?: (script: string, signal: AbortSignal) => Promise<string>;
}

export type WindowsAclBatchReader = (
  paths: readonly string[], options?: WindowsAclBatchOptions,
) => Promise<WindowsAclBatch>;

function batchScript(paths: readonly string[]): string {
  const encoded = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
    `$paths = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    '$entries = @($paths | ForEach-Object {',
    '  $path = $_',
    '  $acl = Get-Acl -LiteralPath $path',
    '  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)',
    '  $rules = @($acl.Access | ForEach-Object {',
    '    [PSCustomObject]@{ Sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; Rights = $_.FileSystemRights.ToString(); ControlType = $_.AccessControlType.ToString() }',
    '  })',
    '  [PSCustomObject]@{ Path = $path; Acl = [PSCustomObject]@{ OwnerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; DaclPresent = (($null -ne $descriptor.DiscretionaryAcl) -and (($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)); AccessRules = $rules } }',
    '})',
    '[PSCustomObject]@{ CurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Entries = $entries } | ConvertTo-Json -Depth 8 -Compress',
  ].join('\n');
}

function createPowershellRunner(spawnHelper: typeof spawn): NonNullable<WindowsAclBatchOptions['run']> {
  let occupied = false;
  return (script, signal) => new Promise((resolve, reject) => {
    if (occupied) { reject(new Error('WINDOWS_ACL_HELPER_BUSY')); return; }
    occupied = true;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }); } catch (error) { occupied = false; reject(error); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    function stop(error: Error) {
      failure ??= error;
      try { child.kill('SIGKILL'); } catch { /* The permit stays held until close, even if kill fails. */ }
    }
    const abort = () => stop(new Error('WINDOWS_ACL_BATCH_ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error('WINDOWS_ACL_BATCH_OUTPUT_LIMIT'));
      else chunks.push(chunk);
    });
    // Bound stderr as well, but never return path-bearing PowerShell diagnostics to the protocol.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error('WINDOWS_ACL_BATCH_OUTPUT_LIMIT'));
    });
    child.on('error', (error) => { failure ??= error; });
    child.stdin.on('error', (error) => stop(error));
    child.once('close', (code) => {
      occupied = false;
      signal.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(new Error('WINDOWS_ACL_BATCH_FAILED'));
      else {
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new Error('WINDOWS_ACL_BATCH_ENCODING')); }
      }
    });
    child.stdin.end(`${script}\n`);
  });
}

/** Fresh operation-local evidence. There is no cross-operation ACL or path cache. */
async function readBatch(paths: readonly string[], options: WindowsAclBatchOptions, runPowershell: NonNullable<WindowsAclBatchOptions['run']>): Promise<WindowsAclBatch> {
  const expected = new Set(paths);
  if (paths.length === 0 || paths.length > maxPaths || expected.size !== paths.length
    || paths.some((path) => typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0'))
    || Buffer.byteLength(JSON.stringify(paths), 'utf8') > maxInputBytes) throw new Error('WINDOWS_ACL_BATCH_INPUT_LIMIT');
  if (options.signal?.aborted) throw new Error('WINDOWS_ACL_BATCH_ABORTED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const abort = () => {
    controller.abort();
    rejectInterrupted(new Error('WINDOWS_ACL_BATCH_ABORTED'));
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(() => {
    controller.abort();
    rejectInterrupted(new Error('WINDOWS_ACL_BATCH_TIMEOUT'));
  }, timeoutMs);
  try {
    const stdout = await Promise.race([(options.run ?? runPowershell)(batchScript(paths), controller.signal), interrupted]);
    if (options.signal?.aborted || controller.signal.aborted) throw new Error('WINDOWS_ACL_BATCH_ABORTED');
    if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) throw new Error('WINDOWS_ACL_BATCH_OUTPUT_LIMIT');
    const raw: unknown = JSON.parse(stdout);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('WINDOWS_ACL_BATCH_INVALID');
    const record = raw as Record<string, unknown>;
    if (typeof record.CurrentSid !== 'string' || !/^S-\d+(?:-\d+)+$/.test(record.CurrentSid)
      || !Array.isArray(record.Entries) || record.Entries.length !== expected.size) throw new Error('WINDOWS_ACL_BATCH_INVALID');
    const acls = new Map<string, WindowsPathAcl>();
    for (const entry of record.Entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.Path !== 'string'
        || !expected.has(entry.Path) || acls.has(entry.Path)) throw new Error('WINDOWS_ACL_BATCH_INVALID');
      const acl = parseWindowsPathAcl(entry.Acl);
      if (acl === undefined || acl.accessRules.length > 4096) throw new Error('WINDOWS_ACL_BATCH_INVALID');
      acls.set(entry.Path, acl);
    }
    return { currentSid: record.CurrentSid, acls };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** A live helper keeps its permit through abort/timeout until its close event proves cleanup. */
export function createWindowsAclBatchReader(options: { spawn?: typeof spawn } = {}): WindowsAclBatchReader {
  const run = createPowershellRunner(options.spawn ?? spawn);
  return async (paths, readOptions = {}) => await readBatch(paths, readOptions, run);
}

export const readWindowsAclBatch = createWindowsAclBatchReader();
