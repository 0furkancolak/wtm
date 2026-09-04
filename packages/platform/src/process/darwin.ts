/**
 * macOS process inspection: three BSD `ps` invocations, moved here unchanged from the two places
 * that already made them.
 *
 * `readStartTime` was `readStartTimeWithPs` in `packages/core/src/runtime/process-identity.ts`,
 * a file this increment deleted once core stopped being allowed to know a platform;
 * `inspectProcess` and `inspectProcessGroup` were free functions in
 * `packages/daemon/src/process-supervisor.ts`. The argument vectors, the environments, the regexes,
 * the zombie handling and the absence detection are byte-for-byte what they were. That is the point
 * of the move: the seam exists so Linux can be added, not so macOS can be re-litigated, and any
 * "improvement" made in passing here would be an unreviewed behaviour change to the code that
 * decides whether a lease may be reclaimed.
 *
 * The two source files spelled the absence check with different names (`isProcessAbsent` and
 * `isPsAbsent`) and identical bodies; one body survives, under the daemon's name.
 *
 * Note that the two environments are also deliberately different, and were before this move:
 * `readStartTime` runs `ps` with a minimal `PATH`, the inspectors run it with the inherited
 * environment plus a C locale. Unifying them would change what the daemon's `ps` sees.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessGroupInspection, ProcessInspection, ProcessPlatform } from '../ports';
import { observedCommandFingerprint, safeErrorCode } from './identity';

const execFileAsync = promisify(execFile);

export interface DarwinCommandOptions {
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

/**
 * Injected so the argument vectors and the parsing can be exercised against captured `ps` output
 * instead of against whatever happens to be running on the test machine. It must reject the way
 * `child_process.execFile` rejects — with `code`, `stdout` and `stderr` on the error — because
 * absence is detected from the shape of that rejection and not from an exit status returned
 * normally.
 */
export type DarwinCommandRunner = (
  file: string,
  args: readonly string[],
  options: DarwinCommandOptions,
) => Promise<{ stdout: string }>;

export interface DarwinProcessPlatformOptions {
  runCommand?: DarwinCommandRunner;
}

const defaultRunCommand: DarwinCommandRunner = async (file, args, options) =>
  await execFileAsync(file, [...args], options);

export function createDarwinProcessPlatform(
  options: DarwinProcessPlatformOptions = {},
): ProcessPlatform {
  const run = options.runCommand ?? defaultRunCommand;

  /**
   * Resolves `null` when the process is absent. A reader that cannot answer — `ps` failing for any
   * reason other than the process being gone, or reporting more than one process for one PID —
   * throws rather than guessing, because a wrong `null` releases somebody else's lease.
   */
  async function readStartTime(pid: number): Promise<string | null> {
    let stdout: string;
    try {
      ({ stdout } = await run('ps', ['-ww', '-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
        maxBuffer: 64 * 1024,
        timeout: 1_000,
      }));
    } catch (error) {
      if (isPsAbsent(error)) return null;
      throw error;
    }
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) return null;
    if (lines.length > 1) {
      throw new Error(`ps reported ${String(lines.length)} processes for PID ${String(pid)}`);
    }
    return lines[0] ?? null;
  }

  async function inspectProcess(pid: number): Promise<ProcessInspection> {
    if (!Number.isSafeInteger(pid) || pid < 1) return { status: 'absent' };
    let stdout: string;
    try {
      stdout = (await run('ps', [
        '-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'state=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command=',
      ], { encoding: 'utf8', env: stableEnvironment(), maxBuffer: 64 * 1024, timeout: 1_000 })).stdout;
    } catch (error) {
      return isPsAbsent(error) ? { status: 'absent' } : { status: 'failed', reason: safeErrorCode(error) };
    }
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return { status: 'absent' };
    if (lines.length !== 1) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+?)\s*$/.exec(lines[0] as string);
    if (match === null) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
    const pgid = Number.parseInt(match[1] as string, 10);
    if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
    if ((match[2] as string).startsWith('Z')) return { status: 'absent' };
    return { status: 'present', identity: {
      pid, pgid, processStartTime: match[3] as string,
      commandFingerprint: observedCommandFingerprint(match[4] as string, match[5] as string),
    } };
  }

  async function inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection> {
    if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'absent' };
    let stdout: string;
    try {
      stdout = (await run('ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'state='], {
        encoding: 'utf8', env: stableEnvironment(), maxBuffer: 4 * 1024 * 1024, timeout: 1_000,
      })).stdout;
    } catch (error) { return { status: 'failed', reason: safeErrorCode(error) }; }
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (match === null) return { status: 'failed', reason: 'PS_PARSE_FAILED' };
      if (Number.parseInt(match[2] as string, 10) === pgid && !(match[3] as string).startsWith('Z')) {
        pids.push(Number.parseInt(match[1] as string, 10));
      }
    }
    return pids.length === 0 ? { status: 'absent' } : { status: 'present', pids };
  }

  /**
   * Moved verbatim from `ManagedProcessSupervisor`'s own default (`process-supervisor.ts`): a
   * negative pid targets the whole POSIX process group. `process.kill` throws synchronously with
   * `code: 'ESRCH'` when nothing answers to that pgid any more, which is the contract the port
   * documents and every call site already relies on.
   */
  function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
    process.kill(-pgid, signal);
  }

  return { readStartTime, inspectProcess, inspectProcessGroup, signalProcessGroup };
}

function stableEnvironment(): NodeJS.ProcessEnv { return { ...process.env, LC_ALL: 'C', LANG: 'C' }; }

/** `ps` exits 1 with nothing on either stream when no process matches the PID. */
function isPsAbsent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 1
    && 'stdout' in error
    && String(error.stdout).trim().length === 0
    && 'stderr' in error
    && String(error.stderr).trim().length === 0;
}
