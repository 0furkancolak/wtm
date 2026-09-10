import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('private UDP batch releases failed binds within the helper descriptor budget', () => {
  const scenario = fileURLToPath(new URL('./endpoint-probe-budget.scenario.ts', import.meta.url));
  const result = runScenario('node', ['--import', 'tsx', scenario]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toBe('passed\n');
});
