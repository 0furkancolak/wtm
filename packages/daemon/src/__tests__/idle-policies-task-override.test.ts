import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./idle-policies-task-override.scenario.ts', import.meta.url));

test('a wtm task set override clears the file-declared idle policy for that task', () => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    idleVisibleBeforeOverride: true,
    idleVisibleAfterOverride: false,
  });
}, 30_000);
