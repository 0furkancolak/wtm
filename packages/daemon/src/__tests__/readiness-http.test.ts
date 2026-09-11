import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('CLI readiness waits beyond five seconds over actual framed IPC and HTTP', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./readiness-http.scenario.ts', import.meta.url))], { timeoutMs: 20000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ready: true, waitedBeyondDefault: true, timeoutKeptService: true, cancelled: true });
}, 25000);
