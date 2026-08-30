import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./endpoint-probe-budget.scenario.ts', import.meta.url));

describe('endpoint allocation probe budget', () => {
  test('stops asking after a bounded number of ports and says that it did', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      // Every probe is a process. Without a budget this was one spawn per port in the band.
      refusals: 256,
      message: 'No available tcp endpoint on 127.0.0.1 in range 20000-50000: '
        + '256 ports were offered and every one was refused.',
      accepted: 1,
      leasedPort: 20000,
    });
  });
});
