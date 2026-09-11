import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('cancellation during final source verification cannot become a successful job result', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-finalization.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
