import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./workspace-scale.scenario.ts', import.meta.url));

describe('release scale fixture', () => {
  test('generates ten repositories, one hundred worktrees, and three running tasks', () => {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toEqual({
      fixture: { repositories: 10, worktrees: 100, runningTasks: 3 },
      warmGlobalStatus: expect.objectContaining({
        path: 'runCli(status --global --json) -> StateDiagnosticDataSource', targetMs: 500,
      }),
      singleRepositoryReconciliation: expect.objectContaining({
        path: 'ReconcilerQueue -> discoverWorkspace/listGitWorktrees -> SQLiteStateStore.reconcileWorktrees', targetMs: 250,
      }),
    });
    // Wall-clock verdicts belong to the performance workflow, which measures on one consistent
    // runner per architecture. Here the claim is that each verdict follows from its measurement.
    for (const measurement of [report.warmGlobalStatus, report.singleRepositoryReconciliation]) {
      expect(measurement.status).toBe(measurement.measuredMs < measurement.targetMs ? 'pass' : 'blocker');
    }
  });
});
