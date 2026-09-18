import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./worktree-reclaimable.scenario.ts', import.meta.url));
for (const mode of [
  'accounting', 'sparse', 'missing', 'root-symlink', 'entry-budget', 'time-budget', 'aborted',
  'unreadable', 'allocation-unavailable', 'changed-file', 'directory-swap', 'depth-budget',
] as const) {
  // depth-budget walks a 66-deep chain to reach the limit, which costs on the order of depth^2
  // metadata calls; it is the one mode whose runtime is bounded by the host rather than by a budget
  // the fixture sets, so it gets headroom the others do not need.
  const timeoutMs = mode === 'depth-budget' ? 60_000 : 15_000;
  test(`bounded worktree reclaimable estimate: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode], { timeoutMs });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  }, timeoutMs + 5_000);
}
