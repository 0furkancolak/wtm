import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('performance report is machine-readable and records release budget semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-perf-report-'));
  try {
    const outputPath = join(root, 'performance.json');
    const result = spawnSync('node', ['--import', 'tsx', 'scripts/performance-report.ts', outputPath], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(report).toEqual(expect.objectContaining({
      schemaVersion: 1,
      fixture: { repositories: 10, worktrees: 100, runningTasks: 3 },
      sourceEditStorm: {
        path: 'WtmDaemon -> StructuralWatcher -> adapterDiscovery', edits: 1000,
        scheduledSignals: 0, adapterDiscoveries: 0, adapterSpawns: 0, status: 'pass',
      },
      release: expect.objectContaining({ blockers: expect.any(Number), warnings: expect.any(Number) }),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
