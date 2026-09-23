import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filesystemMigrationAssets, migrationFileNames } from '../assets';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./assets.scenario.ts', import.meta.url));

function runScenario(): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath]);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('filesystem migration assets', () => {
  test('reads every canonical migration in exact byte order', () => {
    const expected = migrationFileNames.map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));

    expect(filesystemMigrationAssets.readMigrations()).toEqual(expected);
  });

  test('SQLiteStateStore uses its injected migration assets', () => {
    expect(runScenario()).toEqual({ migrationFailed: true, readCount: 1 });
  });
});
