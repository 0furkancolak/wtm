import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./real-world-upgrade.scenario.ts', import.meta.url));

test('a real-world database on migration 9 upgrades to the current 18 cleanly, with no data loss and a fully usable new schema', () => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({
    workspacePreserved: true,
    worktreesPreserved: true,
    leasePreserved: true,
    processPreserved: true,
    newSchemaUsable: true,
  });
}, 30_000);
