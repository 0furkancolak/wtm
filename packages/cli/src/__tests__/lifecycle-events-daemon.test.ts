import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('a running daemon dispatches every documented lifecycle event but worktree.created', () => {
  const result = runScenario('node', [
    '--import', 'tsx', fileURLToPath(new URL('./lifecycle-events-daemon.scenario.ts', import.meta.url)),
  ], { timeoutMs: 30_000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    workspaceDiscovered: true,
    repoDiscovered: true,
    worktreeDiscovered: true,
    worktreeReady: true,
    runtimeStarted: true,
    runtimeStopped: true,
    worktreeRemoved: true,
  });
}, 35_000);
