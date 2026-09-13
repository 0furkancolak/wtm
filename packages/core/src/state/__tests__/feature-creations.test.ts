import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('the feature creation journal keeps one open creation per feature and guards its transitions', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./feature-creations.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    sameFeature: true,
    firstState: 'IN_PROGRESS',
    firstMembers: [[0, 'PLANNED', false], [1, 'PLANNED', true]],
    secondOpenWhileFirstOpen: 'refused',
    openAfterBegin: true,
    supersedingState: 'IN_PROGRESS',
    supersedingFromRef: 'main',
    firstAfterSupersede: 'SUPERSEDED',
    afterFailure: [['PLANNED', 'GIT_COMMAND_FAILED'], ['PLANNED', null]],
    supersedeOnceApplied: 'refused',
    completeBeforeRegistered: 'refused',
    completedState: 'COMPLETED',
    completedAtSet: true,
    openAfterComplete: null,
    membersAfterForgetRepository: 2,
    rowsAfterForgetWorkspace: [0, 0, 0],
  });
});
