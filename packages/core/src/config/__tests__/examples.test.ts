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
  test('parse with supported V1 schema fields and resolve their tasks', async () => {
    const [minimal, bun, compose, polyglot] = await Promise.all(Object.values(examplePaths).map(readExample));

    for (const config of [minimal, bun, compose, polyglot]) {
      expect(Object.keys(config.tasks ?? {})).not.toHaveLength(0);
    }
    expect(minimal.workspace?.name).toBe('minimal');
    expect(bun.environment?.PORT).toBe('{port.web}');
    expect(compose.environment?.COMPOSE_PROJECT_NAME).toBe('{workspace.name}-{repo.name}-wt{id}');
    expect(polyglot.capabilities?.['python.environment-manager']).toBe('uv');
    expect(polyglot.tasks?.['python-test']?.cwd).toBe('{worktree.root}/services/api');

    const resolved = resolveTask({
      config: polyglot,
      taskName: 'python-test',
      isMain: false,
      context: {
        workspace: { root: '/projects/platform', name: 'platform' },
        repo: { root: '/projects/platform/services', name: 'services' },
        main: { root: '/projects/platform/services' },
        worktree: { root: '/projects/platform/services-feature' },
        id: 3,
        key: 'services:3',
        slug: 'services-feature',
        branch: 'feat/examples',
        branchSlug: 'feat-examples',
        ports: {},
        env: {},
      },
    });
    expect(resolved).toMatchObject({
      argv: ['uv', 'run', 'pytest'],
      cwd: '/projects/platform/services-feature/services/api',
      shell: false,
    });
  });
});
