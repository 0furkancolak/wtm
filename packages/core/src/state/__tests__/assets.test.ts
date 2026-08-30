import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filesystemMigrationAssets } from '../assets';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const migrationFiles = [
  '001-initial.sql',
  '002-managed-process-indexes.sql',
  '003-managed-process-reservations.sql',
  '004-managed-process-reservation-leases.sql',
  '005-managed-process-cleanup-ownership.sql',
  '006-resource-lifecycle.sql',
  '007-resource-gc-deleting-phase.sql',
  '008-resource-gc-container-identity.sql',
  '009-lifecycle-events.sql',
] as const;
const scenarioPath = fileURLToPath(new URL('./assets.scenario.ts', import.meta.url));

function runScenario(): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('filesystem migration assets', () => {
  test('reads the nine canonical migrations in exact byte order', () => {
    const expected = migrationFiles.map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));

    expect(filesystemMigrationAssets.readMigrations()).toEqual(expected);
  });

  test('SQLiteStateStore uses its injected migration assets', () => {
    expect(runScenario()).toEqual({ migrationFailed: true, readCount: 1 });
  });
});
