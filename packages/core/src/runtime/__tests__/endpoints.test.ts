import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./endpoints.scenario.ts', import.meta.url));

describe('stable endpoint allocation', () => {
  test('skips a TCP port held by an external process and keeps the fallback lease stable', () => {
    expect(runScenario('os-bind-probe')).toEqual({
      skippedBusyPort: true,
      repeatedLeaseWasStable: true,
    });
  });

  test('serializes concurrent allocators into distinct persisted ports', () => {
    expect(runScenario('concurrent')).toEqual({
      allocatedCount: 6,
      uniqueLeaseCount: 6,
      uniquePortCount: 6,
      repeatedPortsWereStable: true,
    });
  });
});

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
