import { describe, expect, test } from 'bun:test';
import type { WtmConfig } from '../../config/schema';
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

/**
 * There is no `wtm tasks` command — the CLI registers 20 commands and none enumerates them —
 * so this error is the only surface where a user can learn which task names exist.
 */
describe('resolveTask unknown-task reporting', () => {
  const taskNames = (count: number): string[] => Array.from(
    { length: count },
    (_, index) => `make:target-${String(index + 1).padStart(2, '0')}`,
  );
  const configWithTasks = (count: number): WtmConfig => ({
    tasks: Object.fromEntries(taskNames(count).map((name) => [name, { run: ['make', name] }])),
  });
  const resolveMissing = (config: WtmConfig, taskName = 'dev'): WtmTaskResolutionError => {
    try {
      resolveTask({ config, taskName, isMain: true, context: baseContext });
    } catch (error) {
      if (error instanceof WtmTaskResolutionError) return error;
      throw error;
    }
    throw new Error(`resolveTask(${taskName}) resolved a task that does not exist`);
  };

  test('names the tasks that do exist, closest to what was typed first', () => {
    const error = resolveMissing({
      tasks: {
        make: { run: ['make'] },
        'make:dev': { run: ['make', 'dev'] },
        test: { run: ['bun', 'test'] },
      },
    });

    expect(error.code).toBe('WTM_CONFIG_INVALID');
    expect(error.message).toBe('Unknown task: dev. Known tasks: make:dev, test, make.');
  });

  test('says how to define a task when the workspace has none, and prints no empty list', () => {
    const error = resolveMissing({ tasks: {} });

    expect(error.message).toBe(
      'Unknown task: dev. This workspace defines no tasks. '
      + 'Add a [tasks.dev] block with a run command to wtm.toml.',
    );
    expect(error.message).not.toContain('Known tasks');
    expect(error.context).toMatchObject({ taskName: 'dev', knownTasks: [] });
    expect(resolveMissing({}).message).toBe(error.message);
  });

  test('quotes a suggested key that is not a bare TOML key, rather than advising invalid TOML', () => {
    expect(resolveMissing({}, 'make:dev').message).toBe(
      'Unknown task: make:dev. This workspace defines no tasks. '
      + 'Add a [tasks."make:dev"] block with a run command to wtm.toml.',
    );
  });

  test('leads with the closest name, so a hand-written task outranks a wall of adapter tasks', () => {
    const error = resolveMissing({
      tasks: {
        ...configWithTasks(64).tasks,
        'dev-server': { run: ['bun', 'run', 'dev'] },
      },
    });

    expect(error.message).toContain('Known tasks: dev-server, ');
    expect(error.message).toEndWith(' and 55 more.');
  });

  test('ranks the same way whatever order the tasks arrived in, on every call', () => {
    const names = ['make:devtools', 'make:dev', 'dev-server', 'test', 'make'];
    const build = (order: string[]): WtmConfig => ({
      tasks: Object.fromEntries(order.map((name) => [name, { run: ['make', name] }])),
    });

    const first = resolveMissing(build(names));

    expect(first.message)
      .toBe('Unknown task: dev. Known tasks: dev-server, make:dev, make:devtools, test, make.');
    expect(resolveMissing(build(names)).message).toBe(first.message);
    expect(resolveMissing(build([...names].reverse())).message).toBe(first.message);
  });

  test('carries the whole list in context so --json consumers never parse the prose', () => {
    const error = resolveMissing({
      tasks: { zebra: { run: ['zebra'] }, ...configWithTasks(12).tasks, alpha: { run: ['alpha'] } },
    });

    // Alphabetical, not ranked: ranking is a rendering decision and does not belong in a contract.
    expect(error.context.knownTasks).toEqual(['alpha', ...taskNames(12), 'zebra']);
  });

  test('lists at most ten names and counts the remainder', () => {
    expect(resolveMissing(configWithTasks(10)).message)
      .toBe(`Unknown task: dev. Known tasks: ${taskNames(10).join(', ')}.`);

    const over = resolveMissing(configWithTasks(11));

    expect(over.message)
      .toBe(`Unknown task: dev. Known tasks: ${taskNames(10).join(', ')} and 1 more.`);
    expect(over.context.knownTasks).toEqual(taskNames(11));
  });
});
