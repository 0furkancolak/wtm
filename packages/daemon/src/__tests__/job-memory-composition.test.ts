import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('production queue reads the global memory policy and resolves queue worker settings before durable acceptance', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./job-memory-composition.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
