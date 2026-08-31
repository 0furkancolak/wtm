/**
 * A PID alone does not identify a process: the kernel reuses PIDs, so a lease left behind by a
 * dead `wtm` can look alive the moment an unrelated process inherits its number. Pairing the PID
 * with the start time the kernel recorded for it makes the pair unique in practice, which is what
 * the operation-lease logic compares.
 *
 * This is deliberately narrower than the daemon's four-field process identity in
 * `packages/daemon/src/process-supervisor.ts`: a lease owner is a `wtm` process, not a supervised
 * task, so no pgid and no command fingerprint are needed — and core must not import the daemon.
 *
 * `installProcessStartIdentityReader` is a seam, not an API for production callers. It exists for
 * two reasons: tests need to drive absence and identity without spawning real processes, and the
 * platform abstraction planned in the cross-platform increment will supply a non-`ps` reader on
 * Linux and Windows without touching the lease logic that sits above this module. It returns a
 * restore function so an installation cannot leak past the test that made it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessStartIdentity {
  pid: number;
  processStartTime: string;
}

export type ProcessStartTimeReader = (pid: number) => Promise<string | null>;

let readStartTime: ProcessStartTimeReader = readStartTimeWithPs;

export function installProcessStartIdentityReader(reader: ProcessStartTimeReader): () => void {
  const previous = readStartTime;
  readStartTime = reader;
  return () => {
    readStartTime = previous;
  };
}

/**
 * Resolves `null` when the process is absent. A reader that cannot answer — `ps` failing for any
 * reason other than the process being gone, or reporting more than one process for one PID —
 * throws rather than guessing, because a wrong `null` releases somebody else's lease.
 */
export async function readProcessStartIdentity(pid: number): Promise<ProcessStartIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError(`A process identity needs a positive integer PID, received ${String(pid)}`);
  }
  const processStartTime = await readStartTime(pid);
  if (processStartTime === null || processStartTime.length === 0) return null;
  return { pid, processStartTime };
}

async function readStartTimeWithPs(pid: number): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
      maxBuffer: 64 * 1024,
      timeout: 1_000,
    }));
  } catch (error) {
    if (isProcessAbsent(error)) return null;
    throw error;
  }
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  if (lines.length > 1) {
    throw new Error(`ps reported ${String(lines.length)} processes for PID ${String(pid)}`);
  }
  return lines[0] ?? null;
}

/** `ps` exits 1 with nothing on either stream when no process matches the PID. */
function isProcessAbsent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 1
    && 'stdout' in error
    && String(error.stdout).trim().length === 0
    && 'stderr' in error
    && String(error.stderr).trim().length === 0;
}
