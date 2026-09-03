import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./source-edit-storm.scenario.ts', import.meta.url));

test('machine-reports measured scheduling, adapter discovery, and spawn counts for a source storm', () => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
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
