import { describe, expect, test } from 'bun:test';
import { observedCommandFingerprint } from '../identity';
import { createLinuxProcessPlatform, type ProcReader } from '../linux';
import {
  groupStats, initStat, parenthesisedCommCmdline, parenthesisedCommComm, parenthesisedCommStat,
  procListing, procStat, truncatedCommStat, zombieStat,
} from './proc-fixtures';

/**
 * Every test here runs on macOS against captured kernel output. That establishes that the parsing
 * and the absent/failed decisions are right; it establishes nothing about whether a running kernel
 * agrees, which is C2's job and is stated in the increment spec rather than implied by a green run
 * here.
 */

interface FakeProc {
  reader: ProcReader;
  reads: string[];
}

function fakeProc(
  files: Readonly<Record<string, string | Error>>,
  directories: Readonly<Record<string, readonly string[]>> = {},
): FakeProc {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      readFile: async (path) => {
        reads.push(path);
        const entry = files[path];
        if (entry === undefined) throw errno('ENOENT');
        if (entry instanceof Error) throw entry;
        return entry;
      },
      readDirectory: async (path) => {
        const entry = directories[path];
        if (entry === undefined) throw errno('ENOENT');
        return entry;
      },
    },
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(`fake ${code}`), { code });
}

/** The parenthesised-comm process, complete: stat, comm, cmdline and the system's boot time. */
const weirdProcess: Record<string, string> = {
  '/proc/stat': procStat,
  '/proc/9/stat': parenthesisedCommStat,
  '/proc/9/comm': parenthesisedCommComm,
  '/proc/9/cmdline': parenthesisedCommCmdline,
};

describe('inspectProcess', () => {
  test('reports a live process, with fields located past a hostile comm', async () => {
    const { reader } = fakeProc(weirdProcess);
    const platform = createLinuxProcessPlatform({ proc: reader });
    expect(await platform.inspectProcess(9)).toEqual({
      status: 'present',
      identity: {
        pid: 9,
        pgid: 1,
        processStartTime: '1788259322:2778072',
        commandFingerprint: observedCommandFingerprint('weird) app)', '/tmp/weird) app) 30'),
      },
    });
  });

  test('survives a comm the kernel truncated mid-parenthesis', async () => {
    const { reader } = fakeProc({
      '/proc/stat': procStat,
      '/proc/16/stat': truncatedCommStat,
      '/proc/16/comm': '(my (weird) app\n',
      '/proc/16/cmdline': '',
    });
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcess(16);
    expect(inspection).toMatchObject({ status: 'present' });
    expect(inspection.status === 'present' ? inspection.identity.processStartTime : null)
      .toBe('1788259322:2778104');
  });

  test('an empty cmdline is a process with no arguments, not a failure', async () => {
    const { reader } = fakeProc({
      '/proc/stat': procStat, '/proc/1/stat': initStat, '/proc/1/comm': 'bash\n', '/proc/1/cmdline': '',
    });
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcess(1);
    expect(inspection).toEqual({
      status: 'present',
      identity: {
        pid: 1, pgid: 1, processStartTime: '1788259322:2807658',
        commandFingerprint: observedCommandFingerprint('bash', ''),
      },
    });
  });

  test('reports a zombie as absent, matching what the macOS reader does with ps state Z', async () => {
    const { reader } = fakeProc({
      '/proc/stat': procStat,
      '/proc/22/stat': zombieStat,
      '/proc/22/comm': 'sleep\n',
      '/proc/22/cmdline': '',
    });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(22))
      .toEqual({ status: 'absent' });
  });

  test('reports a missing /proc entry as absent', async () => {
    const { reader } = fakeProc({ '/proc/stat': procStat });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(4242))
      .toEqual({ status: 'absent' });
  });

  test('reports a process that exits between the stat and the comm read as absent', async () => {
    const { reader } = fakeProc({ '/proc/stat': procStat, '/proc/9/stat': parenthesisedCommStat });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'absent' });
  });

  test('rejects a non-positive pid without reading anything', async () => {
    const { reader, reads } = fakeProc(weirdProcess);
    const platform = createLinuxProcessPlatform({ proc: reader });
    expect(await platform.inspectProcess(0)).toEqual({ status: 'absent' });
    expect(await platform.inspectProcess(-1)).toEqual({ status: 'absent' });
    expect(await platform.inspectProcess(1.5)).toEqual({ status: 'absent' });
    expect(reads).toEqual([]);
  });

  test('reports a read error as a failure, never as an absence', async () => {
    const { reader } = fakeProc({ '/proc/stat': procStat, '/proc/9/stat': errno('EIO') });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'failed', reason: 'EIO' });
  });

  /**
   * Deliberately the opposite of what the group scan does with the same errno, and the asymmetry is
   * the whole point. The scan enumerates every process on the machine and asks which ones are mine,
   * so an entry it may not read answers that question: not mine. Here the caller named one PID and
   * asked whether *that* process is alive, and "I am not allowed to look" is not an answer — calling
   * it absence would report a running lease holder as gone, and the operations behind those leases
   * delete worktrees.
   */
  test.each(['EACCES', 'EPERM'])('reports a permission denial on a named pid as a failure, never as an absence (%s)', async (code) => {
    const { reader } = fakeProc({ '/proc/stat': procStat, '/proc/9/stat': errno(code) });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'failed', reason: code });
  });

  test('reports an unparseable stat line as a failure, never as an absence', async () => {
    const { reader } = fakeProc({
      '/proc/stat': procStat,
      '/proc/9/stat': 'this is not a stat line\n',
      '/proc/9/comm': 'x\n',
      '/proc/9/cmdline': '',
    });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'failed', reason: 'PROC_PARSE_FAILED' });
  });

  test('reports a /proc/stat with no btime as a failure', async () => {
    const { reader } = fakeProc({ ...weirdProcess, '/proc/stat': 'cpu  1 2 3\n' });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'failed', reason: 'PROC_PARSE_FAILED' });
  });

  /**
   * `ENOENT` means "this process is gone" for `/proc/<pid>` and "this system is broken" for
   * `/proc/stat`. One `catch` around both reads would report the second as the first, and reporting
   * a live process as absent is the one outcome this module may not produce.
   */
  test('reports a missing /proc/stat as a failure, not as the process being absent', async () => {
    const { reader } = fakeProc({
      '/proc/9/stat': parenthesisedCommStat,
      '/proc/9/comm': parenthesisedCommComm,
      '/proc/9/cmdline': parenthesisedCommCmdline,
    });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(9))
      .toEqual({ status: 'failed', reason: 'ENOENT' });
  });

  test('reports a stat line naming a different pid as a failure', async () => {
    const { reader } = fakeProc({
      '/proc/stat': procStat,
      '/proc/7/stat': parenthesisedCommStat,
      '/proc/7/comm': parenthesisedCommComm,
      '/proc/7/cmdline': parenthesisedCommCmdline,
    });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcess(7))
      .toEqual({ status: 'failed', reason: 'PROC_PARSE_FAILED' });
  });

  test('honours an alternate proc root', async () => {
    const { reader } = fakeProc({
      '/host/proc/stat': procStat,
      '/host/proc/9/stat': parenthesisedCommStat,
      '/host/proc/9/comm': parenthesisedCommComm,
      '/host/proc/9/cmdline': parenthesisedCommCmdline,
    });
    const platform = createLinuxProcessPlatform({ proc: reader, procRoot: '/host/proc' });
    expect(await platform.inspectProcess(9)).toMatchObject({ status: 'present' });
  });
});

describe('readStartTime', () => {
  test('returns the boot-time-qualified start tick', async () => {
    const { reader } = fakeProc(weirdProcess);
    expect(await createLinuxProcessPlatform({ proc: reader }).readStartTime(9))
      .toBe('1788259322:2778072');
  });

  test('returns null only for a missing /proc entry', async () => {
    const { reader } = fakeProc({ '/proc/stat': procStat });
    expect(await createLinuxProcessPlatform({ proc: reader }).readStartTime(4242)).toBeNull();
  });

  test.each([
    ['a read error', { '/proc/stat': procStat, '/proc/9/stat': errno('EACCES') }],
    ['an unparseable stat line', { '/proc/stat': procStat, '/proc/9/stat': 'nonsense\n' }],
    ['a /proc/stat with no btime', { '/proc/stat': 'cpu 1\n', '/proc/9/stat': parenthesisedCommStat }],
    ['a missing /proc/stat', { '/proc/9/stat': parenthesisedCommStat }],
  ])('throws rather than returning null for %s, because a wrong null releases a lease', async (_label, files) => {
    const { reader } = fakeProc(files);
    const platform = createLinuxProcessPlatform({ proc: reader });
    await expect(platform.readStartTime(9)).rejects.toThrow();
  });

  /**
   * Deliberately not the zombie rule the inspectors apply. The macOS reader this replaces asks `ps`
   * for `lstart` alone and cannot see a state, so it reports a zombie lease holder as present;
   * making Linux stricter would reclaim a lease macOS holds, which is the wrong-absence failure the
   * whole module is arranged against.
   */
  test('reports a zombie as present, exactly as the macOS lstart reader does', async () => {
    const { reader } = fakeProc({ '/proc/stat': procStat, '/proc/22/stat': zombieStat });
    expect(await createLinuxProcessPlatform({ proc: reader }).readStartTime(22))
      .toBe('1788259322:2778135');
  });
});

describe('inspectProcessGroup', () => {
  const files: Record<string, string | Error> = { '/proc/stat': procStat };
  for (const [pid, stat] of Object.entries(groupStats)) files[`/proc/${pid}/stat`] = stat;

  test('finds every live member of the group', async () => {
    const { reader } = fakeProc(files, { '/proc': procListing });
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6);
    expect(inspection.status).toBe('present');
    expect(inspection.status === 'present' ? [...inspection.pids].sort((a, b) => a - b) : null)
      .toEqual([6, 8, 9, 10]);
  });

  test('skips the non-pid entries /proc is full of', async () => {
    const { reader, reads } = fakeProc(files, { '/proc': procListing });
    await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6);
    expect(reads).not.toContain('/proc/self/stat');
    expect(reads).not.toContain('/proc/cpuinfo/stat');
  });

  test('treats a process that exits mid-scan as gone rather than as a failure', async () => {
    const { reader, reads } = fakeProc(files, { '/proc': procListing });
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6);
    expect(reads).toContain('/proc/11/stat');
    expect(inspection.status).toBe('present');
  });

  test('reports an empty group as absent', async () => {
    const { reader } = fakeProc(files, { '/proc': procListing });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(4242))
      .toEqual({ status: 'absent' });
  });

  test('excludes a zombie member, matching the macOS group reader', async () => {
    const { reader } = fakeProc(
      { ...files, '/proc/22/stat': zombieStat },
      { '/proc': [...procListing, '22'] },
    );
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(1);
    expect(inspection.status === 'present' ? inspection.pids : null).toEqual([1]);
  });

  /**
   * The scan reads every process on the machine, which means it reads other users' processes. Under
   * `hidepid`, systemd's `ProtectProc=`, or an LSM policy those reads are denied, and a denial that
   * aborted the scan would make every group inspection on the host fail. A failed inspection stops
   * the supervisor from killing a group it should kill, so the cost of getting this wrong is a
   * leaked process tree rather than a wrong number.
   */
  test.each(['EACCES', 'EPERM'])('treats a member entry it may not read as not its own, rather than failing the scan (%s)', async (code) => {
    const { reader } = fakeProc({ ...files, '/proc/8/stat': errno(code) }, { '/proc': procListing });
    const inspection = await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6);
    expect(inspection.status === 'present' ? [...inspection.pids].sort((a, b) => a - b) : null)
      .toEqual([6, 9, 10]);
  });

  /**
   * The committed consequence of the rule above, pinned so it cannot be weakened by accident. It is
   * sound for the same reason the rule is: a member of a group this process leads was forked by this
   * process and runs as its user, and every mechanism that hides a `/proc` entry keys on exactly the
   * inspector's inability to inspect a process it does not own. A process cannot be hidden from its
   * own parent. The genuinely broken `/proc` is caught one level up, where `readDirectory` fails.
   */
  test('reports a group as absent when every entry that could have held it was unreadable', async () => {
    const denied: Record<string, string | Error> = { '/proc/stat': procStat };
    for (const entry of procListing) if (/^\d+$/.test(entry)) denied[`/proc/${entry}/stat`] = errno('EACCES');
    const { reader } = fakeProc(denied, { '/proc': procListing });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6))
      .toEqual({ status: 'absent' });
  });

  test('reports a read error that is not a permission denial as a failure, never as an absent group', async () => {
    const { reader } = fakeProc({ ...files, '/proc/8/stat': errno('EIO') }, { '/proc': procListing });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6))
      .toEqual({ status: 'failed', reason: 'EIO' });
  });

  test('reports an unparseable member line as a failure', async () => {
    const { reader } = fakeProc({ ...files, '/proc/8/stat': 'nonsense\n' }, { '/proc': procListing });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6))
      .toEqual({ status: 'failed', reason: 'PROC_PARSE_FAILED' });
  });

  test('reports an unreadable /proc as a failure', async () => {
    const { reader } = fakeProc(files, {});
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(6))
      .toEqual({ status: 'failed', reason: 'ENOENT' });
  });

  test('rejects a non-positive pgid without reading anything', async () => {
    const { reader } = fakeProc(files, { '/proc': procListing });
    expect(await createLinuxProcessPlatform({ proc: reader }).inspectProcessGroup(0))
      .toEqual({ status: 'absent' });
  });
});
