import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('a fresh daemon generation recovers a live task and a task that exited while it was down, from the same durable database', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./daemon-restart-recovery.scenario.ts', import.meta.url))], { timeoutMs: 30_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    recoveredAliveState: 'RUNNING',
    recoveredAlivePidMatches: true,
    recoveredGoneState: 'STOPPED',
    stoppedAfterRestart: 'STOPPED',
  });
}, 35_000);
