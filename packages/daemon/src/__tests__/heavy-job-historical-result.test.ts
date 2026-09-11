import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('historical success rows with an accepted stop reason cannot verify a job result', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-historical-result.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
