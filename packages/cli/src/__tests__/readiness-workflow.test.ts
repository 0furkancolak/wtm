import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('managed HTTP readiness uses real CLI, daemon, owner identity and service lifecycle', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./readiness-workflow.scenario.ts', import.meta.url))], { timeoutMs: 30000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ readiness: true, existing: true, timeoutKeptService: true, invalidRestartPreservedService: true, groupAbsent: true });
}, 35000);
