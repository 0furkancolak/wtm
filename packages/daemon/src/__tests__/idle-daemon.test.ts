import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./idle-daemon.scenario.ts', import.meta.url));

describe('idle daemon release budget', () => {
  test('emits machine-readable CPU p95 and RSS target semantics', () => {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      runtime: 'createProductionDaemon(SQLite, supervisor, Unix server, structural watcher)',
      samples: 20,
      cpuP95: expect.objectContaining({ unit: 'percent', target: 0.2 }),
      rss: expect.objectContaining({ unit: 'MiB', target: 60, investigation: 80 }),
    });
    // Whether this machine meets the budget is not what this test can hold the scenario to: a
    // shared CI runner measures an idle daemon at 0.237% against a 0.2% target where a developer
    // machine measures a third of that. What it can hold is that the verdict follows from the
    // number — which is why `rss` has never asserted its own status here either. The budgets
    // themselves are enforced by the performance workflow, on both architectures.
    expect(report.cpuP95.status).toBe(report.cpuP95.measured < 0.2 ? 'pass' : 'blocker');
    expect(report.rss.status)
      .toBe(report.rss.measured <= 60 ? 'pass' : report.rss.measured <= 80 ? 'warning' : 'blocker');
  }, 30_000);
});
