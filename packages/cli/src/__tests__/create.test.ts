import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./create.scenario.ts', import.meta.url));
let scenario: Record<string, any>;

// One spawn, many assertions: the fixture initialises a real workspace and drives the production
// CLI against a real state store, which is far too slow to repeat per test.
beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as Record<string, any>;
});

describe('wtm create', () => {
  test('creates the worktree beside its repository, named from the branch', () => {
    expect(scenario['created']).toMatchObject({
      exitCode: 0,
      ok: true,
      path: scenario['created'].expectedPath,
      branch: 'refs/heads/feat/auth',
      branchCreated: true,
      onDisk: true,
    });
  });

  test('starts a new branch at the main worktree HEAD', () => {
    // The criterion this serves is "tek repo create deterministic": the branch point is a
    // property of the repository, not of the directory the user happened to be standing in.
    expect(scenario['created'].startPoint).toBe(scenario['created'].mainHead);
  });

  test('--from starts the branch at the named ref instead', () => {
    expect(scenario['from']).toMatchObject({ exitCode: 0, startPoint: 'base' });
    expect(scenario['from'].head).toBe(scenario['from'].baseHead);
  });

  test('the created worktree is registered, so a read command answers about it', () => {
    expect(scenario['statusInside']).toEqual({
      exitCode: 0,
      path: scenario['created'].expectedPath,
      registered: true,
      branch: 'refs/heads/feat/auth',
    });
  });

  test('with no daemon it registers locally and says which hooks did not run', () => {
    // The event dispatcher lives in the daemon, so nothing announced this worktree. Saying so
    // is the difference between a user knowing their `deps.install` hook has not run and
    // finding out when something else fails.
    expect(scenario['created'].registration).toBe('local');
    expect(scenario['created'].warnings).toEqual(['WTM_DAEMON_UNAVAILABLE']);
    expect(scenario['created'].warningMentionsHooks).toBe(true);
    expect(scenario['created'].tellsUserToInit).toBe(false);
  });

  test('an existing branch is checked out rather than restarted somewhere', () => {
    expect(scenario['existingBranch']).toEqual({ exitCode: 0, branchCreated: false, startPoint: null });
  });

  describe('refusals', () => {
    // Each refusal asserts `created: false` as well as its code: "nothing was created" is the
    // load-bearing half, and a command that refused *after* writing would still report the code.
    test('an unregistered directory is WTM_NOT_INITIALIZED, pointing at wtm init', () => {
      expect(scenario['notInitialized']).toMatchObject({ exitCode: 2, code: 'WTM_NOT_INITIALIZED' });
      expect(scenario['notInitialized'].remediation).toEqual([
        { kind: 'command-suggestion', argv: ['wtm', 'init'] },
      ]);
    });

    test('an occupied target path is refused, and the error carries that path', () => {
      expect(scenario['occupied']).toMatchObject({
        exitCode: 3,
        ok: false,
        code: 'WTM_WORKTREE_PATH_OCCUPIED',
        created: false,
      });
      expect(scenario['occupied'].path).toBe(scenario['occupied'].expectedPath);
    });

    test('a branch another worktree holds is refused, naming that worktree', () => {
      expect(scenario['inUse']).toMatchObject({
        exitCode: 3,
        ok: false,
        code: 'GIT_BRANCH_IN_USE',
        created: false,
      });
      expect(scenario['inUse'].worktreePath).toContain('repo');
    });

    test('--from over an existing branch is refused as a contradictory request', () => {
      expect(scenario['fromExisting'])
        .toMatchObject({ exitCode: 2, code: 'WTM_CONFIG_INVALID', created: false });
    });

    test('a name Git will not accept surfaces as GIT_COMMAND_FAILED, creating nothing', () => {
      expect(scenario['badName'])
        .toMatchObject({ exitCode: 1, code: 'GIT_COMMAND_FAILED', created: false });
    });
  });
});
