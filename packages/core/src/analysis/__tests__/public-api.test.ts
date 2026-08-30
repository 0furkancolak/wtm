import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = new URL('./public-api.scenario.ts', import.meta.url).pathname;

test('the public core package has no arbitrary Git execution subpath', () => {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
