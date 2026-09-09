import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('waiting reasons match atomic FIFO claims, held slots and worktree exclusion', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-waiting.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
});
