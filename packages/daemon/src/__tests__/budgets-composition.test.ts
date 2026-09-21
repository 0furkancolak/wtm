import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./budgets-composition.scenario.ts', import.meta.url));

test('production daemon reads the global [budgets] process limit and refuses a start over it', () => {
  const result = runScenario('node', ['--import', 'tsx', scenario, 'process']);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});

test('production daemon reads the global [budgets] memory floor and refuses a start under it', () => {
  const result = runScenario('node', ['--import', 'tsx', scenario, 'memory']);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
