import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

// Same reason as ci-store.test.ts: SQLiteStateStore's better-sqlite3 binding crashes Bun's NAPI
// runtime when constructed directly inside a `bun test` process.
const scenarioPath = fileURLToPath(new URL('./task-overrides.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath, name]);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const devTask = { run: 'npm run dev', shell: true, cwd: '/repo', background: true };

describe('task override store', () => {
  test('sets and reads a task override', () => {
    expect(runScenario('sets-and-reads')).toEqual({
      created: { taskName: 'dev', task: devTask, createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z' },
      fetchedMatchesCreated: true,
      missingIsNull: true,
    });
  });

  test('a second `set` replaces the whole task and keeps the original createdAt', () => {
    expect(runScenario('set-replaces-whole-task-and-keeps-created-at')).toEqual({
      createdAtUnchanged: true,
      updatedAtAdvanced: true,
      taskIsExactlyReplacement: true,
    });
  });

  test('lists only the worktree asked about', () => {
    expect(runScenario('lists-only-its-own-worktree')).toEqual({
      wt1: ['build', 'dev'],
      wt2: ['dev'],
      wt3Length: 0,
    });
  });

  test('unsets one task and deletes every override of a worktree', () => {
    expect(runScenario('unsets-and-deletes-for-worktree')).toEqual({
      unsetMissing: false,
      unsetDev: true,
      devIsGone: true,
      deletedWt1: 1,
      wt2Survives: 1,
    });
  });

  test('drops a row that no longer parses as JSON or as a valid task, instead of throwing', () => {
    expect(runScenario('drops-unparseable-row')).toEqual({
      listedNames: ['dev'],
      brokenJsonIsNull: true,
      wrongShapeIsNull: true,
    });
  });
});
