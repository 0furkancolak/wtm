import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('a running daemon dispatches worktree.created and applies [prepare] mode for wtm create', () => {
  const result = runScenario('node', [
    '--import', 'tsx', fileURLToPath(new URL('./create-daemon-running.scenario.ts', import.meta.url)),
  ], { timeoutMs: 30_000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    hookRan: true,
    eagerPrepared: true,
    lazyPrepared: false,
  });
}, 35_000);
