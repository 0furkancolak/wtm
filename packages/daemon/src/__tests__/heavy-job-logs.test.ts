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
});
