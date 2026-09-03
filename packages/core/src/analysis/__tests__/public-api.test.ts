import { expect, test } from 'bun:test';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenarioPath = new URL('./public-api.scenario.ts', import.meta.url).pathname;

test('the public core package has no arbitrary Git execution subpath', () => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
