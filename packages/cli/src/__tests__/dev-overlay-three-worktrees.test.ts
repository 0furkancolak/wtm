import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('three worktrees\' web dev servers each tell their own identity through the real proxy', () => {
  const result = runScenario('node', [
    '--import', 'tsx', fileURLToPath(new URL('./dev-overlay-three-worktrees.scenario.ts', import.meta.url)),
  ], { timeoutMs: 45_000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const results = JSON.parse(result.stdout);
  expect(results).toEqual({
    main: { ok: true, sawOwnBranch: true, leakedOtherBranch: false },
    'feature/existing': { ok: true, sawOwnBranch: true, leakedOtherBranch: false },
    'feature/third': { ok: true, sawOwnBranch: true, leakedOtherBranch: false },
  });
}, 50_000);
