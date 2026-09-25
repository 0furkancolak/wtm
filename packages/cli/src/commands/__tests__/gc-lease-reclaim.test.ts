import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./gc-lease-reclaim.scenario.ts', import.meta.url));

test('wtm gc gives back the ports of a feature that never ran a task, and keeps any a process still listens on', () => {
  const result = runScenario('node', ['--import', 'tsx', scenario], { timeoutMs: 30_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
}, 35_000);
