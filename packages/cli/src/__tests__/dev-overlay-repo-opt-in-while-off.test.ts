import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('a repository can opt into the dev overlay through the real proxy while the table-level default is off', () => {
  const result = runScenario('node', [
    '--import', 'tsx', fileURLToPath(new URL('./dev-overlay-repo-opt-in-while-off.scenario.ts', import.meta.url)),
  ], { timeoutMs: 45_000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ overlayRendered: true, sawRepoName: true });
}, 50_000);
