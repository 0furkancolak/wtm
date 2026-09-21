import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

// Same reason as task-overrides.test.ts: SQLiteStateStore's better-sqlite3 binding crashes Bun's
// NAPI runtime when constructed directly inside a `bun test` process.
const scenarioPath = fileURLToPath(new URL('./checklist.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath, name]);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('checklist store', () => {
  test('sets and reads a checklist, scoped per worktree', () => {
    expect(runScenario('sets-and-reads')).toEqual({
      items: [
        { position: 0, text: 'Check login', checked: false, createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z' },
        { position: 1, text: 'Run migration', checked: false, createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z' },
      ],
      listedMatchesSet: true,
      emptyForOtherWorktree: 0,
    });
  });

  test('a second `set` replaces the whole list and resets every item to unchecked', () => {
    expect(runScenario('set-replaces-whole-list-and-resets-checked')).toEqual({
      replacedTexts: ['Only item'],
      replacedAllUnchecked: true,
      replacedLength: 1,
    });
  });

  test('setChecked toggles one item by position, leaving the rest untouched', () => {
    expect(runScenario('set-checked-toggles-by-position')).toEqual({
      toggledChecked: true,
      toggledUpdatedAt: '2026-09-21T12:02:00.000Z',
      missingIsNull: true,
      secondIsChecked: true,
      firstStillUnchecked: true,
    });
  });

  test('clear empties one worktree\'s list; deleteForWorktree removes it entirely and leaves others alone', () => {
    expect(runScenario('clear-and-delete-for-worktree')).toEqual({
      cleared: 2,
      wt1AfterClear: 0,
      deleted: 1,
      wt1AfterDelete: 0,
      wt2Survives: 1,
    });
  });

  test('trims item text and drops blank entries', () => {
    expect(runScenario('trims-and-caps-items')).toEqual({
      count: 1,
      firstText: 'padded text',
      firstPosition: 0,
    });
  });
});
