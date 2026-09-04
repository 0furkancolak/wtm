import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TemplateContext } from '../../templates/resolve';
import type { FileTrustPolicy } from '../../file-trust-policy';
import { inspectResources, prepareResources } from '../preparation';
import { createFakeFileTrust } from './file-trust-fixture';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Place {
  root: string;
  main: string;
  worktree: string;
  context: TemplateContext;
}

async function workspace(): Promise<Place> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-resources-'));
  roots.push(root);
  const main = join(root, 'api');
  const worktree = join(root, 'wt', 'api-feat');
  await mkdir(main, { recursive: true });
  await mkdir(worktree, { recursive: true });
  // Every rule here is about what Git already owns, so the worktree has to be a repository.
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  return {
    root,
    main,
    worktree,
    context: {
      workspace: { root, name: 'lab' },
      repo: { root: worktree, name: 'api' },
      main: { root: main },
      worktree: { root: worktree },
      id: 2,
      key: '2',
      slug: 'api-feat',
      branch: 'feat/x',
      branchSlug: 'feat-x',
      ports: {},
      cors: { origins: '' },
      env: {},
    },
  };
}

const declare = (place: Place, resources: object, fileTrust: FileTrustPolicy = createFakeFileTrust()) => ({
  resources: resources as never,
  context: place.context,
  worktreeRoot: place.worktree,
  workspaceRoot: place.root,
  fileTrust,
});

const link = { path: '.env', policy: 'symlink', source: '{main.root}/.env' } as const;

describe('prepareResources', () => {
  test('links the worktree at the file the main working tree holds', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'DATABASE_URL=postgres://local\n');

    const prepared = await prepareResources(declare(place, { env: link }));

    expect(prepared).toEqual([{ name: 'env', path: join(place.worktree, '.env'), policy: 'symlink', state: 'ready' }]);
    // The link names the source's real path, so it survives a symlinked ancestor being moved.
    expect(await readlink(join(place.worktree, '.env'))).toBe(await realpath(join(place.main, '.env')));
    expect(await readFile(join(place.worktree, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://local\n');
  });

  test('preparing again leaves what is already there alone', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'A=1\n');

    await prepareResources(declare(place, { env: link }));
    const second = await prepareResources(declare(place, { env: link }));

    expect(second[0]?.state).toBe('ready');
    expect(await readFile(join(place.worktree, '.env'), 'utf8')).toBe('A=1\n');
  });

  test('a file the worktree already has is never replaced', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'from-main\n');
    await writeFile(join(place.worktree, '.env'), 'mine\n');

    await prepareResources(declare(place, { env: link }));

    expect(await readFile(join(place.worktree, '.env'), 'utf8')).toBe('mine\n');
  });

  test('a path Git tracks is refused', async () => {
    const place = await workspace();
    await writeFile(join(place.main, 'config.json'), '{}');
    await writeFile(join(place.worktree, 'config.json'), '{"tracked":true}');
    execFileSync('git', ['add', 'config.json'], { cwd: place.worktree });
    await rm(join(place.worktree, 'config.json'));

    const [prepared] = await prepareResources(declare(place, {
      config: { path: 'config.json', policy: 'copy', source: '{main.root}/config.json' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('Git tracks this path');
    await expect(readFile(join(place.worktree, 'config.json'))).rejects.toThrow();
  });

  test('a path outside the worktree is refused', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'A=1\n');

    const [prepared] = await prepareResources(declare(place, {
      escape: { path: '../../escaped.env', policy: 'symlink', source: '{main.root}/.env' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('inside its own worktree');
    expect(await readdir(place.root)).not.toContain('escaped.env');
  });

  test('a path inside .git is refused', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'A=1\n');

    const [prepared] = await prepareResources(declare(place, {
      sneaky: { path: '.git/hooks/pre-commit', policy: 'symlink', source: '{main.root}/.env' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('Git administrative paths');
  });

  test('a source outside the workspace is refused', async () => {
    const place = await workspace();
    const outside = await mkdtemp(join(tmpdir(), 'wtm-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secrets.env'), 'TOKEN=1\n');

    const [prepared] = await prepareResources(declare(place, {
      env: { path: '.env', policy: 'symlink', source: join(outside, 'secrets.env') },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('outside the workspace');
  });

  test('a directory on the way that is a symbolic link is refused', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'A=1\n');
    await mkdir(join(place.root, 'elsewhere'));
    await symlink(join(place.root, 'elsewhere'), join(place.worktree, 'config'));

    const [prepared] = await prepareResources(declare(place, {
      env: { path: 'config/.env', policy: 'symlink', source: '{main.root}/.env' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('symbolic link');
    expect(await readdir(join(place.root, 'elsewhere'))).toEqual([]);
  });

  test('a world-writable directory on the way is refused', async () => {
    const place = await workspace();
    await writeFile(join(place.main, '.env'), 'A=1\n');
    const shared = join(place.worktree, 'shared');
    await mkdir(shared);
    // `chmod` documents the scenario -- a directory that became group/world writable -- but the
    // fake `FileTrustPolicy` never reads real mode bits (see `file-trust-fixture.ts`), so the
    // rejection below is driven by the explicit `denyOwnerOnlyWrite` marker, the same signal a
    // real Windows ACL read would produce for this directory.
    await chmod(shared, 0o777);
    const fileTrust = createFakeFileTrust();
    await fileTrust.denyOwnerOnlyWrite(shared);

    const [prepared] = await prepareResources(declare(place, {
      env: { path: 'shared/.env', policy: 'symlink', source: '{main.root}/.env' },
    }, fileTrust));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('world-writable');
  });

  test('an optional resource whose source is absent is missing, not an error', async () => {
    const place = await workspace();

    const [prepared] = await prepareResources(declare(place, { env: { ...link, optional: true } }));

    expect(prepared?.state).toBe('missing');
    expect(prepared?.detail).toContain('does not exist');
  });

  test('a required resource whose source is absent says so', async () => {
    const place = await workspace();

    const [prepared] = await prepareResources(declare(place, {
      seed: { path: 'seed.sqlite', policy: 'copy', source: '{main.root}/seed.sqlite' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('does not exist');
  });

  test('a copy is the worktree’s own file, not the main one', async () => {
    const place = await workspace();
    await writeFile(join(place.main, 'seed.sqlite'), 'seed');

    const [prepared] = await prepareResources(declare(place, {
      seed: { path: 'seed.sqlite', policy: 'copy', source: '{main.root}/seed.sqlite' },
    }));

    expect(prepared?.state).toBe('ready');
    await writeFile(join(place.worktree, 'seed.sqlite'), 'changed');
    expect(await readFile(join(place.main, 'seed.sqlite'), 'utf8')).toBe('seed');
  });

  test('a copy leaves nothing behind when it cannot finish', async () => {
    const place = await workspace();
    await mkdir(join(place.main, 'seed.sqlite'));

    const [prepared] = await prepareResources(declare(place, {
      seed: { path: 'seed.sqlite', policy: 'copy', source: '{main.root}/seed.sqlite' },
    }));

    expect(prepared?.state).toBe('degraded');
    expect(await readdir(place.worktree)).not.toContain('seed.sqlite');
    expect((await readdir(place.worktree)).some((entry) => entry.includes('wtm-partial'))).toBe(false);
  });

  test('an isolated resource is a directory of this worktree’s own', async () => {
    const place = await workspace();

    const [prepared] = await prepareResources(declare(place, { cache: { path: '.cache', policy: 'isolated' } }));

    expect(prepared?.state).toBe('ready');
    await writeFile(join(place.worktree, '.cache', 'x'), 'y');
  });

  test('a policy WTM does not own creates nothing', async () => {
    const place = await workspace();

    const [prepared] = await prepareResources(declare(place, {
      store: { path: '.pnpm-store', policy: 'native-cache' },
    }));

    expect(prepared?.state).toBe('missing');
    expect(await readdir(place.worktree)).not.toContain('.pnpm-store');
  });
});

describe('inspectResources', () => {
  test('says what is there and what is not, and creates nothing', async () => {
    const place = await workspace();
    await writeFile(join(place.worktree, 'present'), 'x');

    const observed = await inspectResources({
      resources: {
        here: { path: 'present', policy: 'copy', source: '{main.root}/present' },
        gone: { path: 'absent', policy: 'copy', source: '{main.root}/absent' },
      } as never,
      context: place.context,
      worktreeRoot: place.worktree,
    });

    expect(observed.map(({ name, state }) => [name, state])).toEqual([['gone', 'missing'], ['here', 'ready']]);
    await expect(readFile(join(place.worktree, 'absent'))).rejects.toThrow();
  });

  test('a link whose target has gone is degraded, not ready', async () => {
    const place = await workspace();
    await symlink(join(place.main, 'never'), join(place.worktree, '.env'));

    const [observed] = await inspectResources({
      resources: { env: link } as never,
      context: place.context,
      worktreeRoot: place.worktree,
    });

    expect(observed?.state).toBe('degraded');
  });
});
