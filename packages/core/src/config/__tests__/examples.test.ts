import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { resolveTask } from '../../runtime/task-resolver';
import { resolveEndpoints } from '../../runtime/endpoint-plan';
import type { EndpointLease, EndpointRequest } from '../../state/store';
import { parseWtmConfig, type WtmConfig } from '../schema';

const examplePaths = {
  minimal: 'examples/minimal/wtm.toml',
  bun: 'examples/bun-monorepo/wtm.toml',
  compose: 'examples/docker-compose/wtm.toml',
  polyglot: 'examples/polyglot/wtm.toml',
  multiRepo: 'examples/multi-repo/wtm.toml',
} as const;

async function readExample(path: string): Promise<WtmConfig> {
  const toml = await readFile(join(process.cwd(), path), 'utf8');
  return parseWtmConfig(parse(toml), path);
}

describe('published example configurations', () => {
  test('parse with supported V1 schema fields and production-resolve every task', async () => {
    const [minimal, bun, compose, polyglot, multiRepo] = await Promise.all([
      readExample(examplePaths.minimal),
      readExample(examplePaths.bun),
      readExample(examplePaths.compose),
      readExample(examplePaths.polyglot),
      readExample(examplePaths.multiRepo),
    ]);

    for (const config of [minimal, bun, compose, polyglot, multiRepo]) {
      expect(Object.keys(config.tasks ?? {})).not.toHaveLength(0);
      // A published example that pairs a preferred port with a range that cannot offer it is
      // an example WTM refuses to run.
      expect(() => resolveExampleEndpoints(config)).not.toThrow();
    }
    expect(minimal.workspace?.name).toBe('minimal');
    expect(compose.environment?.COMPOSE_PROJECT_NAME).toBe('{workspace.name}-{repo.name}-wt{id}');
    expect(polyglot.capabilities?.['python.environment-manager']).toBe('uv');
    expect(polyglot.tasks?.['python-test']?.cwd).toBe('{worktree.root}/services/api');
    // Both repositories read PORT, and each entry has to mean its own endpoint.
    expect(multiRepo.repos?.api?.environment?.PORT).toBe('{port.api}');
    expect(multiRepo.repos?.web?.environment?.PORT).toBe('{port.web}');
    expect(multiRepo.repos?.web?.environment?.VITE_API_URL).toBe('http://localhost:{port.api}');

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
      multiRepo: {
        'api-dev': {
          argv: ['make', 'dev'], cwd: '/projects/example/api', envDelta: {}, background: true, singleton: true,
        },
        'web-dev': {
          argv: ['make', 'dev'], cwd: '/projects/example/web', envDelta: {}, background: true, singleton: true,
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

    for (const [exampleName, config] of Object.entries({ minimal, bun, compose, polyglot, multiRepo }) as [keyof typeof expected, WtmConfig][]) {
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

/** Endpoint resolution against a store that hands out whatever was asked for. */
function resolveExampleEndpoints(config: WtmConfig): void {
  const store = {
    allocateEndpoint: (input: EndpointRequest): EndpointLease => ({
      id: 'lease', worktreeId: input.worktreeId, name: input.name, protocol: input.protocol,
      host: input.host, port: input.preferredPort ?? input.portRange.min, state: 'ACTIVE',
      allocatedAt: '2026-01-01T00:00:00.000Z', lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    }),
    listEndpointLeases: (): EndpointLease[] => [],
  };
  resolveEndpoints(store, {
    ...(config.ports === undefined ? {} : { ports: config.ports }),
    worktreeId: 'worktree', groupWorktreeIds: ['worktree'], index: 1,
  }, () => true);
}
