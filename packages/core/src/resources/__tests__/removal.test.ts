import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import type { ResourceConfig } from '../../config/schema';
import { ResourcePathGuardError } from '../guard';
import { cleanupWorktreeEphemeralResources } from '../removal';

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function worktree(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

function declare(resources: Record<string, ResourceConfig>): Record<string, ResourceConfig> {
  return resources;
}

async function present(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch(() => false);
}

test('deletes an isolated directory so the worktree Git sees is clean again', async () => {
  const fixture = await worktree();
  const cache = join(fixture.linkedWorktreePath, '.wtm-cache');
  await mkdir(join(cache, 'nested'), { recursive: true });
  await writeFile(join(cache, 'nested', 'blob.bin'), 'compiled\n');
  expect((await fixture.git(fixture.linkedWorktreePath, ['status', '--porcelain'])).stdout).not.toBe('');

  const result = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({ cache: { path: '.wtm-cache', policy: 'isolated' } }),
  });

  expect(result.collected).toBe(1);
  expect(result.outcomes).toEqual([
    { name: 'cache', path: cache, policy: 'isolated', disposition: 'deleted' },
  ]);
  expect(await present(cache)).toBe(false);
  // The whole point of the stage: the untracked content WTM made is no longer a removal blocker.
  expect((await fixture.git(fixture.linkedWorktreePath, ['status', '--porcelain'])).stdout).toBe('');
});

test('retains a shared resource with its reason and leaves it on disk', async () => {
  const fixture = await worktree();
  const modules = join(fixture.linkedWorktreePath, 'node_modules');
  await mkdir(modules, { recursive: true });
  await writeFile(join(modules, 'marker'), 'shared\n');

  const result = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({ node_modules: { path: 'node_modules', policy: 'shared' } }),
  });

  expect(result.collected).toBe(0);
  expect(result.outcomes).toEqual([
    { name: 'node_modules', path: modules, policy: 'shared', disposition: 'retained', reason: 'shared' },
  ]);
  expect(await readFile(join(modules, 'marker'), 'utf8')).toBe('shared\n');
});

test('unlinks a symlink resource without touching what it points at', async () => {
  const fixture = await worktree();
  const target = join(fixture.root, 'outside.env');
  await writeFile(target, 'DATABASE_URL=postgres://local\n');
  const link = join(fixture.linkedWorktreePath, '.env');
  await symlink(target, link);

  const result = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({ env: { path: '.env', policy: 'symlink', source: '{main.root}/.env' } }),
  });

  expect(result.collected).toBe(1);
  expect(result.outcomes[0]?.disposition).toBe('deleted');
  expect(await present(link)).toBe(false);
  expect(await readFile(target, 'utf8')).toBe('DATABASE_URL=postgres://local\n');
  expect((await stat(target)).isFile()).toBe(true);
});

test('running twice succeeds, the second run reporting the target already absent', async () => {
  const fixture = await worktree();
  await mkdir(join(fixture.linkedWorktreePath, '.wtm-cache'), { recursive: true });
  const input = {
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({ cache: { path: '.wtm-cache', policy: 'isolated' } }),
  };

  const first = await cleanupWorktreeEphemeralResources(input);
  const second = await cleanupWorktreeEphemeralResources(input);

  expect(first.outcomes[0]?.disposition).toBe('deleted');
  expect(first.collected).toBe(1);
  // `--resume` re-runs this stage, so an absent target is a success and is not counted twice.
  expect(second.outcomes[0]?.disposition).toBe('already-absent');
  expect(second.collected).toBe(0);
  expect(second.retained).toEqual([]);
});

test('refuses a path that resolves outside the worktree and deletes nothing at all', async () => {
  const fixture = await worktree();
  const escape = join(fixture.root, 'escape');
  await mkdir(escape, { recursive: true });
  const inside = join(fixture.linkedWorktreePath, '.wtm-cache');
  await mkdir(inside, { recursive: true });

  const failure = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({
      cache: { path: '.wtm-cache', policy: 'isolated' },
      escape: { path: '../escape', policy: 'isolated' },
    }),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ResourcePathGuardError);
  expect((failure as ResourcePathGuardError).code).toBe('RESOURCE_PATH_DENIED');
  // An abort must never leave a half-cleaned worktree behind.
  expect(await present(escape)).toBe(true);
  expect(await present(inside)).toBe(true);
});

test('refuses a path with a .git component and deletes nothing at all', async () => {
  const fixture = await worktree();
  const inside = join(fixture.linkedWorktreePath, '.wtm-cache');
  await mkdir(inside, { recursive: true });

  const failure = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({
      cache: { path: '.wtm-cache', policy: 'isolated' },
      hook: { path: '.git/wtm', policy: 'ephemeral' },
    }),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ResourcePathGuardError);
  expect((failure as ResourcePathGuardError).code).toBe('RESOURCE_PATH_DENIED');
  expect(await present(inside)).toBe(true);
  expect(await present(join(fixture.linkedWorktreePath, '.git'))).toBe(true);
});

test('refuses a Git-tracked file declared as a resource, and the file survives', async () => {
  const fixture = await worktree();
  const tracked = join(fixture.linkedWorktreePath, 'feature.txt');
  expect(await readFile(tracked, 'utf8')).toBe('safe feature\n');

  const failure = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({ source: { path: 'feature.txt', policy: 'copy', source: '{main.root}/feature.txt' } }),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ResourcePathGuardError);
  expect((failure as ResourcePathGuardError).code).toBe('RESOURCE_TRACKED_FILE_PROTECTED');
  expect(await readFile(tracked, 'utf8')).toBe('safe feature\n');
  expect((await fixture.git(fixture.linkedWorktreePath, ['status', '--porcelain'])).stdout).toBe('');
});

test('reports every retained resource in the shape the removal report carries', async () => {
  const fixture = await worktree();
  await mkdir(join(fixture.linkedWorktreePath, 'node_modules'), { recursive: true });
  const externalPath = join(fixture.root, 'pnpm-store');
  await mkdir(externalPath, { recursive: true });
  const linkedCache = join(fixture.linkedWorktreePath, '.cargo');
  await symlink(externalPath, linkedCache);
  await mkdir(join(fixture.linkedWorktreePath, '.wtm-cache'), { recursive: true });

  const result = await cleanupWorktreeEphemeralResources({
    worktreeRoot: fixture.linkedWorktreePath,
    resources: declare({
      cache: { path: '.wtm-cache', policy: 'isolated' },
      cargo: { path: '.cargo', policy: 'native-cache' },
      node_modules: { path: 'node_modules', policy: 'shared' },
      store: { path: externalPath, policy: 'external' },
      logs: { path: 'logs', policy: 'ignore' },
    }),
  });

  expect(result.collected).toBe(1);
  expect(result.retained).toEqual([
    { name: 'cargo', reason: 'native-cache' },
    { name: 'logs', reason: 'ignore' },
    { name: 'node_modules', reason: 'shared' },
    { name: 'store', reason: 'external' },
  ]);
  expect(await readlink(linkedCache)).toBe(externalPath);
  expect(await present(externalPath)).toBe(true);
  expect(await present(join(fixture.linkedWorktreePath, 'node_modules'))).toBe(true);
});
