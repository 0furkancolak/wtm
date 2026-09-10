import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./symlink-policy.scenario.ts', import.meta.url));
for (const mode of [
  'default', 'ignore', 'review', 'block', 'invalid-policy',
  'error-ignore', 'error-review', 'error-block', 'missing-link',
  'block-initial', 'block-after-cleanup', 'replace-link', 'git-veto-ignore', 'git-veto-review',
]) {
  test(`untracked symlink policy ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  }, 20_000);
}
