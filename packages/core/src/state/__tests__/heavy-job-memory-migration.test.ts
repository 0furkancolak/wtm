import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('migration 13 preserves legacy queue ownership and explicitly leaves old estimates unknown', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-memory-migration.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
