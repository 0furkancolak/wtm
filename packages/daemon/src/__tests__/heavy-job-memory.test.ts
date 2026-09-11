import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('queue admits asynchronously, waits for memory, preserves uncertain reservations and rejects unfit tasks', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-memory.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
