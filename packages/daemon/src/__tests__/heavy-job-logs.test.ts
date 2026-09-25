import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedLogStore } from '../logs';

describe('durable job completion evidence', () => {
  test('bounds and verifies completion identity and removes only private job logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-job-log-'));
    const logs = new ManagedLogStore({ root: join(root, 'logs') });
    try {
      const paths = await logs.prepare('worktree', 'job-unique');
      expect(await logs.readCompletion(paths.stdoutPath, 17)).toBeNull();
      const completion = { pid: 17, exitCode: 7, signal: null, completedAt: '2026-09-09T00:00:00.000Z', logFailed: false, timedOut: false };
      await writeFile(paths.completionMarkerPath, JSON.stringify(completion), { mode: 0o600 });
      expect(await logs.readCompletion(paths.stdoutPath, 17)).toEqual(completion);
      await expect(logs.readCompletion(paths.stdoutPath, 18)).rejects.toThrow('identity');
      await writeFile(paths.completionMarkerPath, 'x'.repeat(2048));
      await expect(logs.readCompletion(paths.stdoutPath, 17)).rejects.toThrow('completion');
      await rm(paths.completionMarkerPath);
      const outside = join(root, 'keep.json');
      await writeFile(outside, JSON.stringify(completion), { mode: 0o600 });
      await symlink(outside, paths.completionMarkerPath);
      await expect(logs.readCompletion(paths.stdoutPath, 17)).rejects.toThrow();
      await expect(logs.removeJob('worktree', 'unique')).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(completion));
      await rm(paths.completionMarkerPath);
      await logs.removeJob('worktree', 'unique');
      expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(completion));
    } finally { await logs.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
  });

  test('the task-exit marker is read by anchor identity, cleared on prepare, and removable with the job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-job-exit-'));
    const logs = new ManagedLogStore({ root: join(root, 'logs') });
    try {
      const paths = await logs.prepare('worktree', 'job-exit');
      expect(paths.exitMarkerPath).toBe(join(paths.stdoutPath, '..', 'exited.json'));
      expect(await logs.readTaskExit(paths.stdoutPath, 17)).toBeNull();
      const exited = { pid: 17, exitCode: 7, signal: null, exitedAt: '2026-09-25T07:27:11.000Z' };
      await writeFile(paths.exitMarkerPath, JSON.stringify(exited), { mode: 0o600 });
      expect(await logs.readTaskExit(paths.stdoutPath, 17)).toEqual(exited);
      await expect(logs.readTaskExit(paths.stdoutPath, 18)).rejects.toThrow('identity');
      await writeFile(paths.exitMarkerPath, 'x'.repeat(2048));
      await expect(logs.readTaskExit(paths.stdoutPath, 17)).rejects.toThrow('exit marker');

      // A new run in the same directory must not inherit the previous run's exit.
      await writeFile(paths.exitMarkerPath, JSON.stringify(exited), { mode: 0o600 });
      const again = await logs.prepare('worktree', 'job-exit');
      expect(await logs.readTaskExit(again.stdoutPath, 17)).toBeNull();

      await writeFile(paths.exitMarkerPath, JSON.stringify(exited), { mode: 0o600 });
      await logs.removeJob('worktree', 'exit');
      expect(await readFile(paths.exitMarkerPath, 'utf8').catch(() => null)).toBeNull();
    } finally { await logs.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
  });
});
