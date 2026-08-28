import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { resolveTask } from '../../runtime/task-resolver';
import { parseWtmConfig, type WtmConfig } from '../schema';

const examplePaths = {
  minimal: 'examples/minimal/wtm.toml',
  bun: 'examples/bun-monorepo/wtm.toml',
  compose: 'examples/docker-compose/wtm.toml',
  polyglot: 'examples/polyglot/wtm.toml',
} as const;

async function readExample(path: string): Promise<WtmConfig> {
  const toml = await readFile(join(process.cwd(), path), 'utf8');
  return parseWtmConfig(parse(toml), path);
}

describe('published example configurations', () => {
  test('parse with supported V1 schema fields and production-resolve every task', async () => {
    const [minimal, bun, compose, polyglot] = await Promise.all(Object.values(examplePaths).map(readExample));

    for (const config of [minimal, bun, compose, polyglot]) {
      expect(Object.keys(config.tasks ?? {})).not.toHaveLength(0);
    }
    expect(minimal.workspace?.name).toBe('minimal');
    expect(compose.environment?.COMPOSE_PROJECT_NAME).toBe('{workspace.name}-{repo.name}-wt{id}');
    expect(polyglot.capabilities?.['python.environment-manager']).toBe('uv');
    expect(polyglot.tasks?.['python-test']?.cwd).toBe('{worktree.root}/services/api');

    const context = {
      workspace: { root: '/projects/example', name: 'example' },
      repo: { root: '/projects/example/repo', name: 'repo' },
      main: { root: '/projects/example/repo' },
      worktree: { root: '/projects/example/repo-feature' },
      id: 3,
      key: 'repo:3',
      slug: 'repo-feature',
      branch: 'feat/examples',
      branchSlug: 'feat-examples',
      env: {},
    };
    const expected = {
      minimal: {
        test: {
          argv: ['npm', 'test'], cwd: '/projects/example/repo-feature', envDelta: {}, background: false, singleton: true,
        },
      },
      bun: {
        dev: {
          argv: ['bun', 'run', 'dev'], cwd: '/projects/example/repo-feature/apps/web', envDelta: {}, background: true, singleton: true,
        },
        test: {
          argv: ['bun', 'test'], cwd: '/projects/example/repo-feature', envDelta: {}, background: false, singleton: true,
        },
      },
      compose: {
        'compose-up': {
          argv: ['docker', 'compose', 'up', '-d'],
          cwd: '/projects/example/repo-feature',
          envDelta: { COMPOSE_PROJECT_NAME: 'example-repo-wt3' },
          background: false,
          singleton: true,
        },
        'compose-down': {
          argv: ['docker', 'compose', 'down'],
          cwd: '/projects/example/repo-feature',
          envDelta: { COMPOSE_PROJECT_NAME: 'example-repo-wt3' },
          background: false,
          singleton: true,
        },
      },
      polyglot: {
        'js-test': {
          argv: ['bun', 'test'], cwd: '/projects/example/repo-feature/services/web', envDelta: {}, background: false, singleton: true,
        },
        'python-test': {
          argv: ['uv', 'run', 'pytest'], cwd: '/projects/example/repo-feature/services/api', envDelta: {}, background: false, singleton: true,
        },
        'rust-test': {
          argv: ['cargo', 'test'], cwd: '/projects/example/repo-feature/services/worker', envDelta: {}, background: false, singleton: true,
        },
      },
    } as const;

    for (const [exampleName, config] of Object.entries({ minimal, bun, compose, polyglot }) as [keyof typeof expected, WtmConfig][]) {
      expect(Object.keys(config.tasks ?? {}).sort()).toEqual(Object.keys(expected[exampleName]).sort());
      for (const [taskName, taskExpected] of Object.entries(expected[exampleName])) {
        expect(resolveTask({ config, taskName, isMain: false, context })).toEqual({
          ...taskExpected,
          shell: false,
        });
      }
    }
  });
});
