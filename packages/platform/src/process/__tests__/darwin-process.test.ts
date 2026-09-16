import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { observedCommandFingerprint } from '../identity';
import {
  createDarwinProcessPlatform, type DarwinCommandOptions, type DarwinCommandRunner,
} from '../darwin';
import { macosExitingInspectLine, macosInspectLine, macosLstartLine } from './proc-fixtures';

/**
 * These tests exist to pin behaviour that was moved, not behaviour that was designed. The macOS
 * readers came from `packages/core/src/runtime/process-identity.ts` (since deleted) and
 * `packages/daemon/src/process-supervisor.ts` unchanged, and the assertions below are about the
 * argument vectors, the environments and the parse results staying exactly what they were — because
 * the seam is worth nothing if extracting it quietly altered the platform it was extracted from.
 */

interface Invocation { file: string; args: readonly string[]; options: DarwinCommandOptions }

function recorder(respond: (invocation: Invocation) => Promise<{ stdout: string }>): {
  run: DarwinCommandRunner;
  invocations: Invocation[];
} {
  const invocations: Invocation[] = [];
  return {
    invocations,
    run: async (file, args, options) => {
      const invocation = { file, args, options };
      invocations.push(invocation);
      return await respond(invocation);
    },
  };
}

function stdout(value: string): DarwinCommandRunner {
  return async () => ({ stdout: value });
}

function psFailure(code: number, out = '', err = ''): DarwinCommandRunner {
  return async () => {
    throw Object.assign(new Error('ps failed'), { code, stdout: out, stderr: err });
  };
}

describe('inspectProcess', () => {
  test('asks ps for exactly the columns it has always asked for', async () => {
    const { run, invocations } = recorder(async () => ({ stdout: macosInspectLine }));
    await createDarwinProcessPlatform({ runCommand: run }).inspectProcess(50437);
    expect(invocations[0]?.file).toBe('ps');
    expect(invocations[0]?.args).toEqual([
      '-ww', '-p', '50437', '-o', 'pgid=', '-o', 'state=', '-o', 'lstart=', '-o', 'comm=', '-o', 'command=',
    ]);
    expect(invocations[0]?.options.env).toMatchObject({ LC_ALL: 'C', LANG: 'C' });
    expect(invocations[0]?.options.timeout).toBe(1_000);
  });

  test('parses a real ps line into an identity', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout(macosInspectLine) });
    expect(await platform.inspectProcess(50437)).toEqual({
      status: 'present',
      identity: {
        pid: 50437,
        pgid: 50437,
        processStartTime: 'Tue Sep  1 21:27:02 2026',
        commandFingerprint: observedCommandFingerprint('/bin/zsh', '/bin/zsh -c echo hello'),
      },
    });
  });

  test('reports a zombie as absent', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout('50437 Z    Tue Sep  1 21:27:02 2026 /bin/zsh /bin/zsh\n'),
    });
    expect(await platform.inspectProcess(50437)).toEqual({ status: 'absent' });
  });

  /**
   * A process whose arguments `ps` could not read is neither the process the caller recorded nor a
   * different one: `getproclline()` substituted `(<p_comm>)` for the whole argument buffer, so both
   * columns carry the same short name and a fingerprint of them would read as a changed identity —
   * which is how the supervisor came to call its own dying child stale. The reader cannot answer,
   * so it says so, and every caller polls again or refuses on `failed`; none of them signal.
   */
  test('reports a process whose arguments are no longer readable as a failure, not an identity', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout(macosExitingInspectLine) });
    expect(await platform.inspectProcess(69874))
      .toEqual({ status: 'failed', reason: 'PS_ARGUMENTS_UNAVAILABLE' });
  });

  test('recognises the unreadable-arguments form when the short name contains a space', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout('70001 R    Mon Sep 14 21:04:18 2026 (Google Chrome He) (Google Chrome He)\n'),
    });
    expect(await platform.inspectProcess(70001))
      .toEqual({ status: 'failed', reason: 'PS_ARGUMENTS_UNAVAILABLE' });
  });

  /**
   * `ps` pads its columns, and a `p_comm` may hold more than one space in a row; neither changes
   * whether the arguments were readable, so neither may change the answer. The column regex above
   * splits on whitespace, so without collapsing it this line would compare `(two  spaces)` against
   * `(two spaces)` and report an identity computed from a name.
   */
  test('recognises the unreadable-arguments form through column padding and repeated spaces', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout('70002 R    Mon Sep 14 21:04:18 2026 (two  spaces)    (two  spaces)   \n'),
    });
    expect(await platform.inspectProcess(70002))
      .toEqual({ status: 'failed', reason: 'PS_ARGUMENTS_UNAVAILABLE' });
  });

  /**
   * The equality of the two columns is the whole signal: a parenthesised `comm` on its own is just
   * a name, and refusing to identify every process that happens to have one would be a new way to
   * lose a lease rather than a way to keep it.
   */
  test('identifies a process whose parenthesised comm differs from its command', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout('70003 S    Mon Sep 14 21:04:18 2026 (node) (node) --version\n'),
    });
    expect(await platform.inspectProcess(70003)).toEqual({
      status: 'present',
      identity: {
        pid: 70003, pgid: 70003, processStartTime: 'Mon Sep 14 21:04:18 2026',
        commandFingerprint: observedCommandFingerprint('(node)', '(node) --version'),
      },
    });
  });

  test('still identifies a live process whose command merely contains parentheses', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout('  512 Ss   Tue Sep  1 21:27:02 2026 /usr/libexec/UserEventAgent /usr/libexec/UserEventAgent (Aqua)\n'),
    });
    expect(await platform.inspectProcess(512)).toEqual({
      status: 'present',
      identity: {
        pid: 512, pgid: 512, processStartTime: 'Tue Sep  1 21:27:02 2026',
        commandFingerprint: observedCommandFingerprint('/usr/libexec/UserEventAgent', '/usr/libexec/UserEventAgent (Aqua)'),
      },
    });
  });

  test('reads ps exiting 1 with silent streams as absence', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: psFailure(1) });
    expect(await platform.inspectProcess(50437)).toEqual({ status: 'absent' });
  });

  test('reads any other ps failure as a failure', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: async () => { throw Object.assign(new Error('spawn'), { code: 'ETIMEDOUT' }); },
    });
    expect(await platform.inspectProcess(50437)).toEqual({ status: 'failed', reason: 'ETIMEDOUT' });
  });

  test('will not accept ps reporting more than one process for one pid', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout(`${macosInspectLine}${macosInspectLine}`),
    });
    expect(await platform.inspectProcess(50437)).toEqual({ status: 'failed', reason: 'PS_PARSE_FAILED' });
  });

  test('reports an unparseable line as a failure', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout('not a ps line\n') });
    expect(await platform.inspectProcess(50437)).toEqual({ status: 'failed', reason: 'PS_PARSE_FAILED' });
  });

  test('rejects a non-positive pid without spawning ps', async () => {
    const { run, invocations } = recorder(async () => ({ stdout: '' }));
    const platform = createDarwinProcessPlatform({ runCommand: run });
    expect(await platform.inspectProcess(0)).toEqual({ status: 'absent' });
    expect(invocations).toEqual([]);
  });
});

describe('readStartTime', () => {
  test('asks ps for lstart alone, with the minimal PATH it has always used', async () => {
    const { run, invocations } = recorder(async () => ({ stdout: macosLstartLine }));
    await createDarwinProcessPlatform({ runCommand: run }).readStartTime(50437);
    expect(invocations[0]?.args).toEqual(['-ww', '-p', '50437', '-o', 'lstart=']);
    expect(invocations[0]?.options.env).toEqual({ PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' });
  });

  test('trims the padding ps emits', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout(macosLstartLine) });
    expect(await platform.readStartTime(50437)).toBe('Tue Sep  1 21:27:02 2026');
  });

  test('returns null when ps says the process is gone', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: psFailure(1) });
    expect(await platform.readStartTime(50437)).toBeNull();
  });

  test('throws rather than returning null when ps fails for another reason', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: psFailure(1, '', 'ps: bad flag') });
    await expect(platform.readStartTime(50437)).rejects.toThrow();
  });

  test('throws when ps reports more than one process for one pid', async () => {
    const platform = createDarwinProcessPlatform({
      runCommand: stdout(`${macosLstartLine}${macosLstartLine}`),
    });
    await expect(platform.readStartTime(50437)).rejects.toThrow(/2 processes/);
  });
});

describe('inspectProcessGroup', () => {
  const listing = ['  1     1 Ss', '50437 50437 Ss', '50440 50437 S', '50441 50437 Z', ''].join('\n');

  test('asks ps for the whole process table', async () => {
    const { run, invocations } = recorder(async () => ({ stdout: listing }));
    await createDarwinProcessPlatform({ runCommand: run }).inspectProcessGroup(50437);
    expect(invocations[0]?.args).toEqual(['-axo', 'pid=', '-o', 'pgid=', '-o', 'state=']);
  });

  test('collects the group, excluding zombies', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout(listing) });
    expect(await platform.inspectProcessGroup(50437))
      .toEqual({ status: 'present', pids: [50437, 50440] });
  });

  test('reports an empty group as absent', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout(listing) });
    expect(await platform.inspectProcessGroup(4242)).toEqual({ status: 'absent' });
  });

  test('reports an unparseable line as a failure, never as an absent group', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: stdout('1 1 Ss\nrubbish\n') });
    expect(await platform.inspectProcessGroup(1)).toEqual({ status: 'failed', reason: 'PS_PARSE_FAILED' });
  });

  test('reports a ps failure as a failure, including exit 1', async () => {
    const platform = createDarwinProcessPlatform({ runCommand: psFailure(1) });
    expect(await platform.inspectProcessGroup(1)).toEqual({ status: 'failed', reason: 'UNKNOWN' });
  });
});

/**
 * The fixtures above say the parser matches captured output. Only a live `ps` says the argument
 * vectors are still ones macOS accepts, which is the half of a move that a fake runner cannot check.
 */
(process.platform === 'darwin' ? describe : describe.skip)('against this machine', () => {
  const platform = createDarwinProcessPlatform();

  test('identifies the running test process', async () => {
    const inspection = await platform.inspectProcess(process.pid);
    expect(inspection.status).toBe('present');
    if (inspection.status !== 'present') return;
    expect(inspection.identity.pid).toBe(process.pid);
    expect(inspection.identity.commandFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await platform.readStartTime(process.pid)).toBe(inspection.identity.processStartTime);
    const group = await platform.inspectProcessGroup(inspection.identity.pgid);
    expect(group.status === 'present' ? group.pids : []).toContain(process.pid);
  });

  test('reports a reaped process as absent', async () => {
    const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    await new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
    expect(await platform.inspectProcess(pid as number)).toEqual({ status: 'absent' });
    expect(await platform.readStartTime(pid as number)).toBeNull();
  });

  /**
   * `ps` refuses a PID above its own maximum by writing to stderr, which is not the silent exit 1
   * that means "no such process". That must reach the caller as a failure: the absence check keys
   * on the streams being empty precisely so a complaining `ps` cannot be read as a dead process.
   */
  test('reports a pid ps refuses to consider as a failure, not as absence', async () => {
    expect(await platform.inspectProcess(0x7fff_fffe)).toMatchObject({ status: 'failed' });
    await expect(platform.readStartTime(0x7fff_fffe)).rejects.toThrow();
  });
});
