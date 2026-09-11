import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./readiness-transport.scenario.ts', import.meta.url));
for (const mode of ['deadline', 'cancel', 'disconnect', 'scope'] as const) {
  test(`readiness transport lifetime: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode], { timeoutMs: 15000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  }, 20000);
}
