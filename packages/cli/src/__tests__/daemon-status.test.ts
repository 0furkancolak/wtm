import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonStatusPath, formatRemediation, nextDaemonStatus, readDaemonStatus, writeDaemonStatus } from '../daemon-status';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'wtm-status-'));
  roots.push(path);
  return path;
}

const failure = {
  started: false as const, code: 'WTM_IPC_PATH_UNUSABLE' as const, condition: 'The WTM daemon socket path is a directory: /x.',
  message: 'The WTM daemon socket path is a directory: /x.', remediation: ['wtm', 'doctor'], permanent: true,
};

describe('daemon-status.json', () => {
  test('round-trips through one private file', () => {
    const path = daemonStatusPath(root());
    const status = nextDaemonStatus(null, failure, new Date('2026-09-11T10:00:00.000Z'), 42);
    writeDaemonStatus(path, status);
    expect(readDaemonStatus(path)).toEqual(status);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('does not leave a temp file behind when the rename fails (review M2)', () => {
    // A directory sitting at the status path makes `renameSync` throw on every launch -- exactly
    // the sustained-failure case this item is about. The temp name is keyed on the writing
    // process's pid, so without cleanup a crash loop would leave one new file per launch.
    const directory = root();
    const path = daemonStatusPath(directory);
    mkdirSync(path);
    const status = nextDaemonStatus(null, failure, new Date('2026-09-11T10:00:00.000Z'), 7);

    writeDaemonStatus(path, status);

    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('reads a missing or corrupt file as no status, never as an exception', () => {
    const path = daemonStatusPath(root());
    expect(readDaemonStatus(path)).toBeNull();
    writeFileSync(path, '{not json');
    expect(readDaemonStatus(path)).toBeNull();
  });

  test('counts a repeated condition from its first occurrence, and restarts the count on a new one', () => {
    const first = nextDaemonStatus(null, failure, new Date('2026-09-11T10:00:00.000Z'), 1);
    const second = nextDaemonStatus(first, failure, new Date('2026-09-11T10:00:10.000Z'), 2);
    expect(second).toMatchObject({ state: 'failed', since: '2026-09-11T10:00:00.000Z', attempts: 2, pid: 2 });
    const other = nextDaemonStatus(second, { ...failure, condition: 'another' }, new Date('2026-09-11T10:00:20.000Z'), 3);
    expect(other).toMatchObject({ since: '2026-09-11T10:00:20.000Z', attempts: 1 });
    const running = nextDaemonStatus(other, { started: true }, new Date('2026-09-11T10:00:30.000Z'), 4);
    expect(running).toMatchObject({ state: 'running', code: null, condition: null, attempts: 1 });
  });

  test('formats a remediation so a path with spaces survives being pasted into a shell', () => {
    expect(formatRemediation(['rm', '/Users/a/Library/Application Support/WTM/.tmd.sock']))
      .toBe("rm '/Users/a/Library/Application Support/WTM/.tmd.sock'");
    expect(formatRemediation(['wtm', 'doctor'])).toBe('wtm doctor');
  });
});
