import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./workspace-scale.scenario.ts', import.meta.url));

describe('release scale fixture', () => {
  test('generates ten repositories, one hundred worktrees, and three running tasks', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      fixture: { repositories: 10, worktrees: 100, runningTasks: 3 },
      warmGlobalStatus: expect.objectContaining({
        path: 'runCli(status --global --json) -> StateDiagnosticDataSource', targetMs: 500, status: 'pass',
      }),
      singleRepositoryReconciliation: expect.objectContaining({
        path: 'ReconcilerQueue -> discoverWorkspace/listGitWorktrees -> SQLiteStateStore.reconcileWorktrees', targetMs: 250, status: 'pass',
      }),
    });
  });
});
