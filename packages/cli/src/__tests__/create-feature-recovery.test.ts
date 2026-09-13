import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./create-feature-recovery.scenario.ts', import.meta.url));
let scenario: Record<string, any>;

beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as Record<string, any>;
});

describe('wtm create --resume', () => {
  test('a failed member leaves the others in place and points at --resume', () => {
    // The injected failure is not a GitCommandError, so it maps to GIT_REPOSITORY_DEGRADED; a real
    // Git failure would be GIT_COMMAND_FAILED.
    expect(scenario['partial']).toEqual({
      ok: false,
      code: 'GIT_REPOSITORY_DEGRADED',
      remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', 'feat/partial', '--resume'] }],
      failedOnDisk: false,
      othersOnDisk: [true, true],
      failedPhase: 'PLANNED',
      otherPhases: ['APPLIED', 'APPLIED'],
    });
  });

  test('a new create of an unfinished feature is refused', () => {
    expect(scenario['plainWhileOpen']).toEqual({ code: 'WTM_OPERATION_CONFLICT' });
  });

  test('resume finishes the feature, recording where each member was', () => {
    expect(scenario['resumedPartial']).toEqual({
      ok: true, resumed: true,
      failedRecoveredFrom: 'PLANNED',
      otherRecoveredFrom: ['APPLIED', 'APPLIED'],
      phases: ['REGISTERED', 'REGISTERED', 'REGISTERED'],
      onDisk: [true, true, true],
    });
  });

  test('a member Git finished but the journal did not record is recognised, not re-added', () => {
    expect(scenario['crashed']).toEqual({ ok: false, apiPhase: 'APPLYING' });
    expect(scenario['resumedCrashed']).toMatchObject({ ok: true, onDisk: [true, true, true] });
    expect(scenario['resumedCrashed'].recoveredFrom['api']).toBe('APPLYING');
  });

  test('an APPLYING member Git never started is created at its pinned commit', () => {
    expect(scenario['resumedHalted']).toEqual({ ok: true, apiRecoveredFrom: 'APPLYING', onDisk: [true, true, true] });
  });

  test('something unexpected at the path is refused, and nothing is deleted', () => {
    expect(scenario['resumedLeftover']).toEqual({ ok: false, code: 'WTM_WORKTREE_PATH_OCCUPIED', keptFile: true, othersStillThere: [true, true] });
  });

  test('a creation that wrote nothing is superseded by a new create', () => {
    expect(scenario['superseded']).toEqual({ firstOk: false, secondOk: true, states: ['SUPERSEDED', 'COMPLETED'], members: 2 });
  });

  test('--resume refuses a different --repos set and any --from', () => {
    expect(scenario['guards']).toEqual({ setupOk: false, mismatch: 'WTM_CONFIG_INVALID', fromWithResume: 'WTM_CONFIG_INVALID' });
  });

  test('a held lease on one member refuses the creation before anything is written', () => {
    expect(scenario['busy']).toEqual({ code: 'WTM_OPERATION_CONFLICT', onDisk: [false, false, false] });
  });

  test('a finished member of a forgotten repository is skipped; one with work left is refused by name', () => {
    expect(scenario['forgotten']).toEqual({ doneOk: true, doneLastOnDisk: true, leftOk: false, leftCode: 'WTM_CONFIG_INVALID', leftNamesRepository: true, leftLastOnDisk: false });
  });
});
