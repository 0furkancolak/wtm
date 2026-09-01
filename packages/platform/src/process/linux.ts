/**
 * Linux process inspection, read from `/proc`.
 *
 * There is no `ps` here on purpose. `/proc` is the kernel's own answer, it needs no subprocess, and
 * — the part that matters for this project — it distinguishes "this process is gone" from "I could
 * not find out" structurally: a gone process is a missing directory, and a missing directory is the
 * only thing this module is ever allowed to call absence.
 *
 * That distinction is the safety-critical one and it is worth restating in full, because the code
 * below is otherwise unremarkable. WTM compares a stored `(pid, startTime)` pair against the live
 * process to decide whether an operation lease may be reclaimed. Reporting absence for a process
 * that is merely unreadable reclaims a lease that somebody else is still holding, and the operations
 * behind those leases delete worktrees. So: `ENOENT` on `/proc/<pid>` is absence. A read error, a
 * permission error, an unparseable line, a `/proc/stat` without a `btime` — every one of those is a
 * *failure*, reported as `failed` or thrown, never as absence.
 *
 * Everything is read through an injected reader so the parsing and the absent/failed decisions are
 * exercised against captured kernel output. This increment adds no Linux CI job and this file has
 * never run on a kernel; what its tests establish is that the decisions are right, and nothing at
 * all about whether the kernel agrees.
 */
import { readdir, readFile } from 'node:fs/promises';
import type { ProcessGroupInspection, ProcessInspection, ProcessPlatform } from '../ports';
import { observedCommandFingerprint, safeErrorCode } from './identity';
import { linuxStartTime, parseBootTime, parseProcStat } from './proc-stat';

export interface ProcReader {
  readFile(path: string): Promise<string>;
  readDirectory(path: string): Promise<readonly string[]>;
}

export interface LinuxProcessPlatformOptions {
  proc?: ProcReader;
  /** Overridable for tests and for a `/proc` mounted somewhere unusual in a container. */
  procRoot?: string;
}

export const defaultProcReader: ProcReader = {
  readFile: async (path) => await readFile(path, 'utf8'),
  readDirectory: async (path) => await readdir(path),
};

export function createLinuxProcessPlatform(
  options: LinuxProcessPlatformOptions = {},
): ProcessPlatform {
  const proc = options.proc ?? defaultProcReader;
  const root = options.procRoot ?? '/proc';

  /**
   * Boot time is re-read on every call rather than cached. Caching it would be an obvious
   * optimisation and a bad trade: `btime` is recomputed by the kernel and is not guaranteed stable
   * across a suspend/resume, and a cached stale value would silently turn every identity
   * comparison on the machine into a mismatch — which, for a lease, means reclaiming it. The macOS
   * path spawns a whole `ps` per call, so one extra `/proc/stat` read is not the cost worth taking
   * that risk for.
   */
  async function readBootTime(): Promise<string> {
    const bootTime = parseBootTime(await proc.readFile(`${root}/stat`));
    if (bootTime === null) throw new Error('PROC_PARSE_FAILED');
    return bootTime;
  }

  /**
   * Resolves `null` when the process is absent, and throws for everything else — the contract the
   * macOS `ps -o lstart=` reader has always had.
   *
   * A zombie is reported *present* here, and that is deliberate rather than an oversight of the
   * zombie rule the inspectors below apply. The macOS reader this replaces asks `ps` for `lstart`
   * and nothing else: it has no state column, so it has never been able to call a zombie absent,
   * and it reports one as a live lease holder. Making Linux stricter would mean a lease that macOS
   * holds and Linux reclaims, which is a wrong absence — the one failure mode this whole module is
   * arranged to prevent — in exchange for releasing a lease a few milliseconds before the parent
   * reaps the child. The inspectors are a different question and answer it differently.
   */
  async function readStartTime(pid: number): Promise<string | null> {
    let content: string;
    try {
      content = await proc.readFile(`${root}/${String(pid)}/stat`);
    } catch (error) {
      if (isMissingEntry(error)) return null;
      throw error;
    }
    const fields = parseProcStat(content);
    if (fields === null) throw new Error('PROC_PARSE_FAILED');
    return linuxStartTime(await readBootTime(), fields.startTimeTicks);
  }

  async function inspectProcess(pid: number): Promise<ProcessInspection> {
    if (!Number.isSafeInteger(pid) || pid < 1) return { status: 'absent' };
    const directory = `${root}/${String(pid)}`;
    let statContent: string;
    let commContent: string;
    let cmdlineContent: string;
    try {
      statContent = await proc.readFile(`${directory}/stat`);
      // A process that exits between these reads makes the later ones vanish. That is still
      // absence, which is why they share one `try` with the first read rather than getting their
      // own error handling that would have to repeat the judgement.
      commContent = await proc.readFile(`${directory}/comm`);
      cmdlineContent = await proc.readFile(`${directory}/cmdline`);
    } catch (error) {
      if (isMissingEntry(error)) return { status: 'absent' };
      return { status: 'failed', reason: safeErrorCode(error) };
    }
    // Boot time gets its own handling because `ENOENT` means something else here. A missing
    // `/proc/<pid>` is a dead process; a missing `/proc/stat` is a broken system, and folding the
    // two into one `catch` would report the second as the first.
    let bootTime: string;
    try {
      bootTime = await readBootTime();
    } catch (error) { return { status: 'failed', reason: safeErrorCode(error) }; }
    const fields = parseProcStat(statContent);
    if (fields === null) return { status: 'failed', reason: 'PROC_PARSE_FAILED' };
    // The kernel names the directory after the PID, so a line reporting a different one means the
    // file being read is not the file that was asked for. Nothing sane produces that; reporting it
    // as a failure keeps it from being read as an identity.
    if (fields.pid !== pid) return { status: 'failed', reason: 'PROC_PARSE_FAILED' };
    if (fields.pgrp < 1) return { status: 'failed', reason: 'PROC_PARSE_FAILED' };
    if (fields.state.startsWith('Z')) return { status: 'absent' };
    return { status: 'present', identity: {
      pid,
      pgid: fields.pgrp,
      processStartTime: linuxStartTime(bootTime, fields.startTimeTicks),
      commandFingerprint: observedCommandFingerprint(
        readComm(commContent), readCommandLine(cmdlineContent),
      ),
    } };
  }

  async function inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection> {
    if (!Number.isSafeInteger(pgid) || pgid < 1) return { status: 'absent' };
    let entries: readonly string[];
    try {
      entries = await proc.readDirectory(root);
    } catch (error) { return { status: 'failed', reason: safeErrorCode(error) }; }
    const pids: number[] = [];
    for (const entry of entries) {
      // `/proc` mixes PID directories with `cpuinfo`, `meminfo`, `self` and the rest. Only the
      // all-digit names are processes.
      if (!/^\d+$/.test(entry)) continue;
      let content: string;
      try {
        content = await proc.readFile(`${root}/${entry}/stat`);
      } catch (error) {
        // A process exiting while the directory is being walked is the normal case, not an error:
        // the scan takes long enough that it happens on any busy machine. Anything else is a
        // failure, because a group reported as absent stops a supervisor from killing it.
        if (isMissingEntry(error)) continue;
        return { status: 'failed', reason: safeErrorCode(error) };
      }
      const fields = parseProcStat(content);
      if (fields === null) return { status: 'failed', reason: 'PROC_PARSE_FAILED' };
      if (fields.pgrp === pgid && !fields.state.startsWith('Z')) pids.push(fields.pid);
    }
    return pids.length === 0 ? { status: 'absent' } : { status: 'present', pids };
  }

  return { readStartTime, inspectProcess, inspectProcessGroup };
}

/**
 * `/proc/<pid>/comm` is the kernel's 15-byte-truncated task name, newline terminated. It is the
 * Linux counterpart of the executable path macOS's `ps -o comm=` prints — shorter and less
 * informative, but readable for every process on the machine, which `/proc/<pid>/exe` is not:
 * resolving that symlink for a process owned by another user needs ptrace permission and would turn
 * an inspection that should read `present` into one that reads `failed`.
 */
function readComm(content: string): string { return content.replace(/\n$/, ''); }

/**
 * `/proc/<pid>/cmdline` is NUL-separated with a trailing NUL. Joining the arguments with spaces
 * reproduces exactly what macOS's `ps -o command=` prints, including its ambiguity about arguments
 * that themselves contain spaces — a fidelity match rather than a defect, since the fingerprint is
 * only ever compared with another reading of the same process.
 *
 * A kernel thread has an empty `cmdline`. That is a real process with an empty command line, not a
 * failure.
 */
function readCommandLine(content: string): string {
  return content.replace(/\0+$/, '').split('\0').join(' ');
}

/** The process is gone: its `/proc` directory no longer exists. */
function isMissingEntry(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ESRCH');
}
