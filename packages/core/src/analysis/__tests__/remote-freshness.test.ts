import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./remote-freshness.scenario.ts', import.meta.url));

test('analysis completes with a git that refuses every fetch, and the refresh does not', () => {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath], {
    timeout: scenarioTimeoutMs,
    encoding: 'utf8',
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    readiness: 'SAFE',
    blockerCodes: [],
    remoteKnowledge: {
      source: 'local-refs',
      refreshed: false,
      refreshedAt: null,
      confidence: 'LOCAL_ONLY',
    },
    refreshFailure: { code: 'GIT_COMMAND_FAILED', exitCode: 78 },
  });
});
