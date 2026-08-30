import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const scenarioPath = fileURLToPath(new URL('./task-resolution.scenario.ts', import.meta.url));

describe('worktree runtime resolution', () => {
  test('resolves one answer for a worktree in a workspace of several repositories', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');

    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(observed).toEqual({
      workspaceTaskVisible: ['node', 'server.js'],
      workspaceRoot: true,
      workspaceMakefileTask: ['make', 'dev'],
      branch: 'feature/existing',
      nestedResolvesToWorktree: true,
      featureGroup: (observed.featureGroup as string[]),
      portInRange: true,
      sharedAcrossRepositories: true,
      separateFromOtherFeature: true,
      publishedEnvironment: {
        PORT: true,
        API_URL: true,
        BRANCH: 'feature/existing',
        CORS_ORIGINS: true,
      },
      task: { argv: ['node', 'server.js'], cwd: true, port: true },
      unregistered: 'This directory is not inside a worktree WTM has registered. Run `wtm init` in the workspace root.',
    });
    // One feature, two repositories: the branch is checked out in both, and both belong to it.
    expect((observed.featureGroup as string[]).length).toBe(2);
  }, 30_000);
});
