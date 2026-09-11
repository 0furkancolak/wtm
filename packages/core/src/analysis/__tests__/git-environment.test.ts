import { describe, expect, test } from 'bun:test';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./git-environment.scenario.ts', import.meta.url));

describe('Git environment isolation', () => {
  test('analyzes repo A authoritatively under inherited and runtime routing aimed at repo B', () => {
    const scenario = runScenario('hostile-routing', {
      GIT_DIR: '/definitely/not/a/repository',
      GIT_WORK_TREE: '/definitely/not/a/worktree',
      GIT_COMMON_DIR: '/definitely/not/a/common-dir',
      GIT_INDEX_FILE: '/definitely/not/an/index',
      GIT_OBJECT_DIRECTORY: '/definitely/not/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/definitely/not/alternate-objects',
      GIT_NAMESPACE: 'inherited-hostile',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: '/definitely/not/a/worktree',
    });

    expect(scenario).toMatchObject({
      // `analyzedPath` is a real filesystem path from the git fixture, backslash-joined on
      // win32 — match the host's own separator rather than a POSIX literal.
      analyzedPath: expect.stringContaining(`${sep}linked feature`),
      blockerCodes: ['GIT_DIRTY_UNSTAGED'],
      repoBStatus: '',
      environmentUnchanged: true,
      sentinel: 'preserved',
    });
  });

  test('preserves an isolated global excludes config and blocks its ignored file', () => {
    expect(runScenario('global-excludes')).toEqual({
      blockerCodes: ['GIT_IGNORED_CONTENT'],
      untrackedPaths: [],
      ignoredPaths: ['global.secret'],
      globalConfigUnchanged: true,
    });
  });
});

function runScenario(name: string, extraEnvironment: Record<string, string> = {}): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath, name], {
    env: { ...process.env, ...extraEnvironment },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
