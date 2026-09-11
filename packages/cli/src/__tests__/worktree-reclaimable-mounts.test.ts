import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./worktree-reclaimable-mounts.scenario.ts', import.meta.url));
for (const mode of [
  'same-device-directory', 'same-device-file', 'escaped-path', 'root-mount',
  'unreadable', 'malformed', 'duplicate-id', 'invalid-utf8', 'byte-budget', 'record-budget',
  'descendant-changed', 'ancestor-changed', 'unrelated-changed',
] as const) {
  test(`worktree estimate respects Linux mount evidence: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, mode], { timeoutMs: 15_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode, verified: true });
  }, 20_000);
}
