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
import { processObservationBudgetFor } from './observation-budget';

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
        timeout: processObservationBudgetFor('darwin'),
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
      ], { encoding: 'utf8', env: stableEnvironment(), maxBuffer: 64 * 1024, timeout: processObservationBudgetFor('darwin') })).stdout;
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
    if (argumentsUnavailable(`${match[4] as string} ${match[5] as string}`)) {
      return { status: 'failed', reason: 'PS_ARGUMENTS_UNAVAILABLE' };
    }
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
        encoding: 'utf8', env: stableEnvironment(), maxBuffer: 4 * 1024 * 1024, timeout: processObservationBudgetFor('darwin'),
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

/**
 * `ps` prints `(<p_comm>)` in BOTH the `comm` and the `command` column when the kernel will not hand
 * it a process's argument vector, and a fingerprint taken from that is not the process's
 * fingerprint — it is the reader failing to read, spelled as if it were an answer.
 *
 * Why both columns: in Apple's `ps` (adv_cmds, `ps/keyword.c`) `comm` and `command` are the same
 * printer over the same buffer — `comm` is `just_command`, `command` is `command`, and both go
 * through `p_command_and_or_args()` onto `getproclline()`, which differ only in whether the NUL
 * separators past argv[0] are turned into spaces. `getproclline()` is also where the fallback lives:
 * when `KERN_PROCARGS2` fails it produces `asprintf(&name, "(%s)", p_comm)` for the whole buffer, so
 * the two columns come out identical. That is why the columns are compared to each other rather
 * than to any expected text: the equality IS the signal.
 *
 * Why it happens to a live process. `ps` reads the process table once (`KERN_PROC`) and then asks
 * `KERN_PROCARGS2` per process, so the two reads are not one instant. A process that begins exiting
 * between them is still in the snapshot with a live state — `R<s`, no `E`, no `Z`, confirmed in CI
 * run `34896095080` — while `KERN_PROCARGS2` already refuses. For a task this daemon stops, that
 * window opens by construction: `SIGTERM` is sent and the very next poll can land inside it.
 * Reading it as an identity is what turned "my own child is dying" into "a different process holds
 * this PID", i.e. `RUNTIME_PROCESS_IDENTITY_STALE`.
 *
 * The two columns are matched as one string because `p_comm` may contain spaces, which the column
 * regex above splits on; whitespace runs are collapsed first because that regex also normalises the
 * padding `ps` emits between columns and would otherwise make a two-space name compare unequal to
 * itself. `p_comm` is at most `MAXCOMLEN` (16) bytes and is never empty.
 *
 * A live process whose real argv[0] and whole command line are both literally that parenthesised
 * short name would be reported unreadable too. That is the safe direction: `failed` only ever makes
 * a caller poll again or refuse — no caller treats it as absence, and none of them signal on it.
 */
function argumentsUnavailable(columns: string): boolean {
  return /^(\(.{1,16}\)) \1$/.test(columns.replace(/\s+/g, ' ').trim());
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
