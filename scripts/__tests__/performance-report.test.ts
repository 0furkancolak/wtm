import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// This drives the whole performance harness — all three scenarios, end to end — and the ordinary
// suite has already run each of them individually. That duplicate is 45 seconds on a fast machine
// and more than the timeout on a slow one, which is how it failed a release twice while measuring
// nothing the suite had not already measured. `bun run test:perf` sets this, and is where the
// harness belongs.
const performanceSuite = process.env['WTM_PERFORMANCE_SUITE'] === '1';

test.skipIf(!performanceSuite)('performance report is machine-readable and records release budget semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-perf-report-'));
  try {
    const outputPath = join(root, 'performance.json');
    const result = spawnSync('node', ['--import', 'tsx', 'scripts/performance-report.ts', outputPath], { encoding: 'utf8' });
    // The script reports a blocked budget by exiting 1, and writes the report either way. What is
    // under test is the report the release reads, not whether the machine running the suite is
    // fast enough — a shared CI runner blocks budgets that the same commit met minutes earlier.
    // Budgets are enforced by the performance workflow, on one consistent runner.
    expect([0, 1], result.stderr || result.stdout).toContain(result.status);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    // The exit code has to mean what the report says, or nothing downstream can trust either.
    expect(result.status === 1).toBe(report.release.blockers > 0);
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
