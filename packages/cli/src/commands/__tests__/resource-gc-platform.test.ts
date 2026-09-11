import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./resource-gc-platform.scenario.ts', import.meta.url));
for (const mode of ['guard-deny', 'dry-run', 'apply', 'recovery', 'recovery-deny'] as const) {
  test(`production GC preserves selected platform file-trust decisions: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode], { timeoutMs: 15_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, policyVerified: true });
  }, 20_000);
}
