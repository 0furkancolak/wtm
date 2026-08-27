import { describe, expect, test } from 'bun:test';
import { resolveTask, WtmTaskResolutionError } from '../task-resolver';

const baseContext = {
  workspace: { root: '/projects/demo', name: 'demo' },
  repo: { root: '/projects/demo/repo', name: 'repo' },
  main: { root: '/projects/demo/repo' },
  worktree: { root: '/projects/demo/repo' },
  id: 1,
  key: 'repo:1',
  slug: 'repo-main',
  branch: 'main',
  branchSlug: 'main',
  ports: { web: 23001 },
  env: { HOME: '/Users/developer', SHARED: 'ambient' },
};

describe('resolveTask', () => {
  test('selects the main command while linked worktree #3 receives its templated command', () => {
    const config = {
      tasks: {
        dev: {
          main: ['make', 'dev'],
          worktree: ['make', 'dev-with-worktree-{id}'],
          cwd: '{workspace.root}',
        },
      },
    };

    expect(resolveTask({ config, taskName: 'dev', isMain: true, context: baseContext }).argv)
      .toEqual(['make', 'dev']);
    expect(resolveTask({
      config,
      taskName: 'dev',
      isMain: false,
      context: {
        ...baseContext,
        worktree: { root: '/projects/demo/repo-feature' },
        id: 3,
        key: 'repo:3',
        slug: 'repo-feature',
        branch: 'feat/runtime',
        branchSlug: 'feat-runtime',
      },
    })).toMatchObject({
      argv: ['make', 'dev-with-worktree-3'],
      shell: false,
      cwd: '/projects/demo',
      background: false,
      singleton: true,
    });
  });

  test('merges ambient, workspace and task environment for templates while returning only the delta', () => {
    const resolved = resolveTask({
      config: {
        environment: {
          SHARED: 'workspace',
          CACHE_ROOT: '{env.HOME}/.cache/{workspace.name}',
          WEB_URL: 'http://127.0.0.1:{port.web}',
        },
        tasks: {
          dev: {
            run: ['node', '--title={env.TITLE}', '{env.WEB_URL}'],
            env: {
              SHARED: 'task',
              TITLE: '{env.SHARED}-{branch.slug}',
            },
          },
        },
      },
      taskName: 'dev',
      isMain: false,
      context: {
        ...baseContext,
        worktree: { root: '/projects/demo/repo-feature' },
        id: 3,
        branchSlug: 'feat-runtime',
      },
    });

    expect(resolved).toMatchObject({
      argv: ['node', '--title=task-feat-runtime', 'http://127.0.0.1:23001'],
      cwd: '/projects/demo/repo-feature',
      envDelta: {
        SHARED: 'task',
        CACHE_ROOT: '/Users/developer/.cache/demo',
        WEB_URL: 'http://127.0.0.1:23001',
        TITLE: 'task-feat-runtime',
      },
    });
    expect(resolved.envDelta).not.toHaveProperty('HOME');
  });

  test('keeps shell execution opt-in and represents an approved shell string as one argv entry', () => {
    expect(resolveTask({
      config: { tasks: { legacy: { run: 'printf "%s" "$WTM_ID"', shell: true } } },
      taskName: 'legacy',
      isMain: true,
      context: baseContext,
    })).toMatchObject({
      argv: ['printf "%s" "$WTM_ID"'],
      shell: true,
    });

    expect(() => resolveTask({
      config: { tasks: { unsafe: { run: 'make dev' } } } as never,
      taskName: 'unsafe',
      isMain: true,
      context: baseContext,
    })).toThrow('string commands require shell = true');
  });

  test('rejects missing tasks and context-specific commands with typed configuration errors', () => {
    expect(() => resolveTask({
      config: { tasks: {} },
      taskName: 'missing',
      isMain: true,
      context: baseContext,
    })).toThrow(WtmTaskResolutionError);

    expect(() => resolveTask({
      config: { tasks: { dev: { main: ['make', 'dev'] } } },
      taskName: 'dev',
      isMain: false,
      context: baseContext,
    })).toThrow('does not define a linked-worktree command');
  });
});
