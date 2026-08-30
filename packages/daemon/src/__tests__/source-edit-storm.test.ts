import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./source-edit-storm.scenario.ts', import.meta.url));

test('machine-reports measured scheduling, adapter discovery, and spawn counts for a source storm', () => {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    path: 'WtmDaemon -> StructuralWatcher -> adapterDiscovery',
    edits: 1000,
    scheduledSignals: 0,
    adapterDiscoveries: 0,
    adapterSpawns: 0,
    status: 'pass',
  });
});
