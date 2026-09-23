import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
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

  /**
   * Every other assertion here, and `build-sea.test.ts`'s equivalent one, derives its "expected"
   * list from `migrationFileNames` itself, so both are tautological about that array's
   * completeness -- neither can notice a `.sql` file sitting in `migrations/` that nobody added to
   * the array. That is exactly the failure CLAUDE.md's "Migrations" section warns a new migration
   * ships without ("the standalone executable ships without it"): a file landed on disk, the array
   * edit did not (a merge conflict resolved wrong, a copy-paste that skipped the last step), and
   * `bun run typecheck && bun run lint && bun run test` all stay green while the migration is
   * silently never applied anywhere. This is the one assertion that reads the directory itself
   * rather than trusting the array, so it fails loudly the moment those two disagree either way.
   */
  test('migrationFileNames lists every .sql file actually on disk, and only those', () => {
    const onDisk = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    expect(onDisk).toEqual([...migrationFileNames]);
  });
});
