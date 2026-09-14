import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('migration 14 keeps every lease row, admits create, and adds the feature journal', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./feature-creations-migration.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    leasesPreserved: true,
    tables: ['feature_creation_members', 'feature_creations', 'features'],
    // create only adds a worktree, so a queued job elsewhere in the repository is no reason to refuse it.
    createLease: 'acquired',
    // remove, gc and repair keep the guard.
    removeRefusal: 'WTM_OPERATION_CONFLICT',
  });
});
