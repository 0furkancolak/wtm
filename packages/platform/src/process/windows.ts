/**
 * The Windows `ProcessPlatform` (spec `2026-09-04-windows-process-supervision.md`, Increment D2).
 *
 * Windows has no POSIX process group: there is no kernel-tracked id that every descendant of a
 * spawned process inherits for free the way `pgid` is inherited on macOS/Linux. WTM's own protocol
 * already treats `pgid` as nothing but "the root process's own pid" — the supervisor and the anchor
 * both refuse a handshake unless `identity.pgid === identity.pid`
 * (`process-supervisor.ts`'s `ANCHOR_HANDSHAKE_INVALID`, `process-anchor.ts`'s own refusal) — so
 * this reader answers `inspectProcessGroup(pgid)` by walking the live process tree rooted at that
 * pid instead of querying a kernel group that does not exist here.
 *
 * Identity comes from `Get-CimInstance Win32_Process`, shelled to the same way every other port in
 * this package answers its platform's identity question (`ps`, `/proc`, `Get-Acl`) rather than a
 * native addon. `CreationDate` is asked for in round-trip (`"o"`) format so it arrives as an
 * unambiguous string instead of PowerShell's default `/Date(...)/` serialization — the same
 * "reshape before `ConvertTo-Json`, not after" choice `trust/windows-powershell.ts` already made
 * for a SID.
 *
 * `ParentProcessId` can lie once a pid is reused: Windows does not clear a child's recorded parent
 * id when that parent exits, so a later, unrelated process that lands on the same numeric pid would
 * otherwise look like a member of this tree. Every parent-child edge below is accepted only if the
 * child's `CreationDate` is not earlier than the parent's — a real child cannot be created before
 * the process it names as its parent — the same start-time discipline this project already applies
 * to `(pid, startTime)` pairs elsewhere (`operation-lease.ts`).
 *
 * **This is documented, fixture-tested behaviour, not a measurement.** Nothing on this macOS host
 * can run `powershell.exe`, enumerate a real Windows process table, or terminate a real process
 * tree with `taskkill`. In particular, `signalProcessGroup`'s reading of `taskkill`'s exit code 128
 * as "already gone" is Microsoft's documented behaviour, not something exercised here — Increment
 * D2's Windows CI leg is where that, and everything else in this file, is measured against a real
 * kernel for the first time, the same caveat C1 attached to the Linux `sun_path` limit before C2
 * measured it.
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessGroupInspection, ProcessInspection, ProcessPlatform } from '../ports';
import { observedCommandFingerprint, safeErrorCode } from './identity';

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 5_000;

export interface WindowsProcessRecord {
  readonly processId: number;
  readonly parentProcessId: number;
  /** Round-trip (`"o"`) formatted, or `''` when `Get-CimInstance` reported no creation date at all. */
  readonly creationDate: string;
  readonly name: string;
  readonly commandLine: string;
}

/**
 * Runs one `powershell.exe -Command <script>` and resolves its stdout. Injected so the parsing and
 * tree-walking below can be exercised against captured `ConvertTo-Json` output instead of a real
 * Windows host — the same seam `trust/windows-powershell.ts`'s `PowershellRunner` is.
 */
export type WindowsProcessQueryRunner = (script: string) => Promise<{ stdout: string }>;

/**
 * Runs `taskkill.exe` synchronously and never throws itself — the result's `status`/`stdout`/
 * `stderr`/`error` are inspected by the caller, the same shape `node:child_process.spawnSync`
 * already returns. `signalProcessGroup` must stay synchronous to keep `ProcessPlatform`'s contract
 * (`process.kill`'s own contract: succeed or throw before returning, never later) on every
 * platform, which is why this is `spawnSync`-shaped rather than `execFile`-shaped like the readers
 * above.
 */
export type WindowsTaskkillRunner = (args: readonly string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface WindowsProcessPlatformOptions {
  runQuery?: WindowsProcessQueryRunner;
  runTaskkill?: WindowsTaskkillRunner;
}

const defaultRunQuery: WindowsProcessQueryRunner = async (script) => {
  return await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: commandTimeoutMs,
    // Measured in `2026-09-03-a-hang-that-cannot-hide.md` (Increment C3): a child that ignores the
    // default `SIGTERM` makes `timeout` wait forever instead of bounding the call. `SIGKILL` is what
    // turns "at most 5 seconds" from a request into a bound.
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
};

const defaultRunTaskkill: WindowsTaskkillRunner = (args) => {
  const result = spawnSync('taskkill.exe', [...args], {
    encoding: 'utf8',
    timeout: commandTimeoutMs,
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

const processFieldsSelect = [
  "@{n='ProcessId';e={$_.ProcessId}}",
  "@{n='ParentProcessId';e={$_.ParentProcessId}}",
  "@{n='CreationDate';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' } }}",
  "@{n='Name';e={$_.Name}}",
  "@{n='CommandLine';e={$_.CommandLine}}",
].join(', ');

function allProcessesScript(): string {
  return `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | `
    + `Select-Object ${processFieldsSelect} | ConvertTo-Json -Compress`;
}

function oneProcessScript(pid: number): string {
  return `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}' | `
    + `Select-Object ${processFieldsSelect} | ConvertTo-Json -Compress`;
}

interface RawWindowsProcess {
  ProcessId?: unknown;
  ParentProcessId?: unknown;
  CreationDate?: unknown;
  Name?: unknown;
  CommandLine?: unknown;
}

function parseWindowsProcess(raw: RawWindowsProcess): WindowsProcessRecord | undefined {
  if (typeof raw.ProcessId !== 'number' || typeof raw.ParentProcessId !== 'number') return undefined;
  if (typeof raw.CreationDate !== 'string' || typeof raw.Name !== 'string') return undefined;
  return {
    processId: raw.ProcessId,
    parentProcessId: raw.ParentProcessId,
    creationDate: raw.CreationDate,
    name: raw.Name,
    commandLine: typeof raw.CommandLine === 'string' ? raw.CommandLine : '',
  };
}

/** `ConvertTo-Json` serializes a single matching object bare, not inside a one-element array. */
function parseWindowsProcessList(stdout: string): WindowsProcessRecord[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('POWERSHELL_PARSE_FAILED');
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const records: WindowsProcessRecord[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = parseWindowsProcess(entry as RawWindowsProcess);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** The `code` `ManagedProcessSupervisor` already checks for on every other platform's `signalProcessGroup`. */
export class WindowsProcessGroupNotFoundError extends Error {
  readonly code = 'ESRCH' as const;

  constructor(pgid: number) {
    super(`No Windows process tree rooted at pid ${String(pgid)}.`);
    this.name = 'WindowsProcessGroupNotFoundError';
  }
}

export function createWindowsProcessPlatform(
  options: WindowsProcessPlatformOptions = {},
): ProcessPlatform {
  const runQuery = options.runQuery ?? defaultRunQuery;
  const runTaskkill = options.runTaskkill ?? defaultRunTaskkill;

  async function readStartTime(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const { stdout } = await runQuery(oneProcessScript(pid));
    const match = parseWindowsProcessList(stdout).find((record) => record.processId === pid);
    return match === undefined ? null : match.creationDate;
  }

  async function inspectProcess(pid: number): Promise<ProcessInspection> {
    if (!Number.isSafeInteger(pid) || pid < 1) return { status: 'absent' };
    let stdout: string;
    try {
      ({ stdout } = await runQuery(oneProcessScript(pid)));
    } catch (error) {
      return { status: 'failed', reason: safeErrorCode(error) };
    }
    let records: WindowsProcessRecord[];
    try {
      records = parseWindowsProcessList(stdout);
    } catch (error) {
      return { status: 'failed', reason: safeErrorCode(error) };
    }
    const match = records.find((record) => record.processId === pid);
    if (match === undefined) return { status: 'absent' };
    return {
      status: 'present',
      identity: {
        pid,
        // The anchor this is ever asked about is always its own tree's root (D2 above), so its pgid
        // is its own pid by the same protocol invariant every platform's anchor enforces.
        pgid: pid,
        processStartTime: match.creationDate,
        commandFingerprint: observedCommandFingerprint(match.name, match.commandLine),
      },
    };
  }

  async function inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection> {
    if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'absent' };
    let stdout: string;
    try {
      ({ stdout } = await runQuery(allProcessesScript()));
    } catch (error) {
      return { status: 'failed', reason: safeErrorCode(error) };
    }
    let records: WindowsProcessRecord[];
    try {
      records = parseWindowsProcessList(stdout);
    } catch (error) {
      return { status: 'failed', reason: safeErrorCode(error) };
    }
    const byPid = new Map(records.map((record) => [record.processId, record]));
    const childrenByParent = new Map<number, WindowsProcessRecord[]>();
    for (const record of records) {
      // A process cannot legitimately be its own parent; guarding against it here keeps a
      // malformed row from making the walk below loop on itself forever.
      if (record.processId === record.parentProcessId) continue;
      const siblings = childrenByParent.get(record.parentProcessId);
      if (siblings === undefined) childrenByParent.set(record.parentProcessId, [record]);
      else siblings.push(record);
    }
    // Walked from `childrenByParent.get(pgid)` directly rather than from `byPid.get(pgid)`'s own
    // record, and deliberately not gated on that record existing: on Windows the root's own process
    // can have already exited while its children linger as orphans (Windows never clears a dead
    // parent's declared `ParentProcessId`, so the edge survives), and this is exactly the case the
    // daemon calls this method to catch after a `signalProcessGroup` — a wrong "absent" here would
    // report a kill as clean when a straggler is still alive.
    const root = byPid.get(pgid);
    const pids: number[] = root === undefined ? [] : [pgid];
    const queue: WindowsProcessRecord[] = [];
    const rootCreationDate = root?.creationDate ?? '';
    for (const child of childrenByParent.get(pgid) ?? []) {
      if (child.creationDate !== '' && rootCreationDate !== '' && child.creationDate < rootCreationDate) continue;
      pids.push(child.processId);
      queue.push(child);
    }
    while (queue.length > 0) {
      const parent = queue.shift() as WindowsProcessRecord;
      for (const child of childrenByParent.get(parent.processId) ?? []) {
        if (child.creationDate !== '' && parent.creationDate !== '' && child.creationDate < parent.creationDate) {
          continue;
        }
        pids.push(child.processId);
        queue.push(child);
      }
    }
    if (pids.length === 0) return { status: 'absent' };
    return { status: 'present', pids };
  }

  function signalProcessGroup(pgid: number, _signal: NodeJS.Signals): void {
    // Windows collapses WTM's graceful/forceful two-phase shutdown into one: Node's own
    // `ChildProcess.kill()` already force-terminates unconditionally on Windows regardless of the
    // signal argument passed to it, so unconditional `/F` here is not a downgrade from what a
    // "SIGTERM" would have done — `/T` reaches the whole tree, which a plain `TerminateProcess` on
    // just the root pid would not.
    const result = runTaskkill(['/PID', String(pgid), '/T', '/F']);
    if (result.error !== undefined) throw result.error;
    if (result.status === 0) return;
    if (result.status === 128) throw new WindowsProcessGroupNotFoundError(pgid);
    throw new Error(`taskkill exited ${String(result.status)}: ${(result.stderr.trim() || result.stdout.trim())}`);
  }

  return { readStartTime, inspectProcess, inspectProcessGroup, signalProcessGroup };
}
