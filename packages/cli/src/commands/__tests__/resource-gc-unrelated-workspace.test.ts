import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./resource-gc-unrelated-workspace.scenario.ts', import.meta.url));

test('wtm gc is not broken by an unrelated workspace\'s lost repository', () => {
  const result = runScenario('node', ['--import', 'tsx', scenario], { timeoutMs: 15_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
}, 20_000);
