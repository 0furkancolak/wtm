import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./private-directory-policy-path.scenario.ts', import.meta.url));

for (const mode of ['create', 'verify', 'owner-denied', 'access-denied', 'unreadable', 'replaced'] as const) {
  test(`private directory keeps path-dependent trust and descriptor identity checks: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  });
}
