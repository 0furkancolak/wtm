import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario, scenarioTestTimeoutMs } from '../../../testkit/src/scenario-child';

test('two daemons under two different HOMEs run at the same time without seeing each other', () => {
  const result = runScenario('node', [
    '--import', 'tsx', fileURLToPath(new URL('./dual-home-daemons.scenario.ts', import.meta.url)),
  ], { env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    isolatedPaths: true, simultaneouslyLive: true, taskIsolation: true, independentLifecycle: true,
  });
}, scenarioTestTimeoutMs());
