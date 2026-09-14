import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./create-feature.scenario.ts', import.meta.url));
let scenario: Record<string, any>;

beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as Record<string, any>;
});

describe('wtm create --repos', () => {
  test('creates one worktree per repository under one feature, from the workspace root', () => {
    expect(scenario['created']).toMatchObject({
      exitCode: 0, ok: true, featureBranch: 'refs/heads/feat/auth', featureId: true,
      registration: 'local', resumed: false, warnings: ['WTM_DAEMON_UNAVAILABLE'],
      onDisk: [true, true, true],
    });
    expect(scenario['created'].members.map((m: any) => m.path).sort()).toEqual(scenario['created'].expectedPaths);
  });

  test('every member is registered, created new, and started at its own repository HEAD', () => {
    for (const member of scenario['created'].members) {
      expect(member).toMatchObject({ phase: 'REGISTERED', created: true, startPointIsOwnHead: true });
    }
    expect(scenario['statusInside']).toEqual({ exitCode: 0, registered: true });
  });

  test('an unknown repository name is refused before anything is written', () => {
    expect(scenario['unknownName']).toEqual({ code: 'WTM_CONFIG_INVALID', unknown: ['nope'], webCreated: false });
  });

  test('one member refused by pre-flight refuses the whole creation and writes nothing', () => {
    expect(scenario['blocked']).toEqual({ ok: false, codes: ['WTM_WORKTREE_PATH_OCCUPIED'], nothingWritten: true });
  });

  test('a daemon that answers the reconcile registers the members', () => {
    expect(scenario['daemon']).toEqual({ ok: true, registration: 'daemon', warnings: [] });
  });

  test('--resume with nothing to resume is refused', () => {
    expect(scenario['noRepos']).toEqual({ code: 'WTM_CONFIG_INVALID' });
  });

  test('several [repos] entries naming one repository are a configuration error, not a Git failure', () => {
    expect(scenario['duplicateEntries']).toEqual({ ok: false, codes: ['WTM_CONFIG_INVALID'], nothingWritten: true });
  });
});
