import { execFile } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { installProcessStartIdentityReader, readProcessStartIdentity } from '../process-identity';

describe('process start identity', () => {
  test('reads a stable start time for a live process', async () => {
    const identity = await readProcessStartIdentity(process.pid);

    expect(identity).not.toBeNull();
    expect(identity?.pid).toBe(process.pid);
    expect(identity?.processStartTime.length).toBeGreaterThan(0);

    const second = await readProcessStartIdentity(process.pid);
    expect(second?.processStartTime).toBe(identity?.processStartTime as string);
  });

  test('reports a process that has already exited as absent', async () => {
    const deadPid = await pidOfAnExitedProcess();

    expect(await readProcessStartIdentity(deadPid)).toBeNull();
  });

  test('an installed reader replaces the implementation and sees the PID it was asked about', async () => {
    const observed: number[] = [];
    const restore = installProcessStartIdentityReader(async (pid) => {
      observed.push(pid);
      return 'Mon Jan  1 00:00:00 2035';
    });

    try {
      expect(await readProcessStartIdentity(4_242)).toEqual({
        pid: 4_242,
        processStartTime: 'Mon Jan  1 00:00:00 2035',
      });
      expect(observed).toEqual([4_242]);
    } finally {
      restore();
    }

    // The restore seam must leave the real reader in place for every other test.
    expect((await readProcessStartIdentity(process.pid))?.pid).toBe(process.pid);
  });

  test('an installed reader returning null makes the identity absent', async () => {
    const restore = installProcessStartIdentityReader(async () => null);

    try {
      expect(await readProcessStartIdentity(process.pid)).toBeNull();
    } finally {
      restore();
    }
  });

  test('rejects a PID that is not a positive integer before it reaches the reader', async () => {
    const observed: number[] = [];
    const restore = installProcessStartIdentityReader(async (pid) => {
      observed.push(pid);
      return 'never';
    });

    try {
      for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
        await expect(readProcessStartIdentity(pid)).rejects.toBeInstanceOf(TypeError);
      }
      expect(observed).toEqual([]);
    } finally {
      restore();
    }
  });
});

/**
 * A PID that is guaranteed to have existed and to be gone, rather than a large number guessed to
 * be free: the child is waited out before its PID is reused.
 */
async function pidOfAnExitedProcess(): Promise<number> {
  return await new Promise<number>((resolvePid, rejectPid) => {
    const child = execFile(process.execPath, ['-e', ''], (error) => {
      if (error !== null) rejectPid(error);
      else if (typeof child.pid === 'number') resolvePid(child.pid);
      else rejectPid(new Error('The probe child never reported a PID'));
    });
  });
}
