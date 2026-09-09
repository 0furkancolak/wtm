import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('shares one daemon slot across independent CLI processes and repositories', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./jobs-workflow.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ detached: true, sharedSlot: true, idempotent: true, resultsVerified: true });
}, 30_000);
