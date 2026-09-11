import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./worktree-reclaimable.scenario.ts', import.meta.url));
for (const mode of [
  'accounting', 'sparse', 'missing', 'root-symlink', 'entry-budget', 'time-budget', 'aborted',
  'unreadable', 'allocation-unavailable', 'changed-file', 'directory-swap', 'depth-budget',
] as const) {
  test(`bounded worktree reclaimable estimate: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode], { timeoutMs: 15_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  }, 20_000);
}
