import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  ResourcePathGuardError,
  createResourceGuard,
  type GitTrackingInspector,
} from '../guard';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(tracked: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'wtm-resource-guard-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const sandboxRoot = join(workspaceRoot, '.wtm-resources');
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  await chmod(sandboxRoot, 0o700);
  const trackedSet = new Set(tracked);
  const git: GitTrackingInspector = {
    async isTracked(_repositoryRoot, candidate) {
      return trackedSet.has(candidate);
    },
  };
  const guard = await createResourceGuard({
    sandboxRoot,
    workspaceRoot,
    repositoryRoots: [workspaceRoot],
    gitDirectoryPaths: [join(workspaceRoot, '.git'), join(root, 'external.git')],
    homeDirectory: homedir(),
    git,
  });
  return { root, workspaceRoot, sandboxRoot, guard };
}

describe('resource sandbox guard', () => {
  test.each([
    ['filesystem root', '/'],
    ['user home', homedir()],
  ])('rejects %s as a mutation target', async (_label, target) => {
    const { guard } = await fixture();
    await expect(guard.authorize(target, 'delete')).rejects.toBeInstanceOf(ResourcePathGuardError);
  });

  test('rejects workspace/repository roots and .git paths', async () => {
    const { guard, workspaceRoot } = await fixture();
    for (const target of [workspaceRoot, join(workspaceRoot, '.git'), join(workspaceRoot, '.git', 'objects')]) {
      await expect(guard.authorize(target, 'delete')).rejects.toMatchObject({ code: 'RESOURCE_PATH_DENIED' });
    }
  });

  test('rejects configured external worktree gitdir targets', async () => {
    const { guard, root } = await fixture();
    await expect(guard.authorize(join(root, 'external.git'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
  });

  test('rejects nested repositories and linked-worktree gitfiles', async () => {
    const { guard, sandboxRoot, root } = await fixture();
    const nested = join(sandboxRoot, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, '.git'), `gitdir: ${join(root, 'external.git')}\n`);
    await expect(guard.authorize(join(nested, 'cache'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
  });

  test('rejects a repository marker introduced at the sandbox root after guard creation', async () => {
    const { guard, sandboxRoot, root } = await fixture();
    await writeFile(join(sandboxRoot, '.git'), `gitdir: ${join(root, 'external.git')}\n`);
    await expect(guard.authorize(join(sandboxRoot, 'cache'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
  });

  test('rejects Git-tracked paths even when the sandbox is inside the repository', async () => {
    const targetName = '.wtm-resources/tracked.txt';
    const { guard, sandboxRoot } = await fixture([targetName]);
    const target = join(sandboxRoot, 'tracked.txt');
    await writeFile(target, 'source');
    await expect(guard.authorize(target, 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_TRACKED_FILE_PROTECTED',
    });
  });

  test('protects missing tracked paths, descendants, and literal pathspec characters', async () => {
    const tracked = [
      '.wtm-resources/missing[1].txt',
      '.wtm-resources/tree/descendant.txt',
    ];
    const { sandboxRoot, workspaceRoot } = await fixture();
    const guard = await createResourceGuard({
      sandboxRoot,
      workspaceRoot,
      repositoryRoots: [workspaceRoot],
      git: {
        async isTracked(_root, candidate) {
          return tracked.some((path) => path === candidate || path.startsWith(`${candidate}/`));
        },
      },
    });
    await expect(guard.authorize(join(sandboxRoot, 'missing[1].txt'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_TRACKED_FILE_PROTECTED',
    });
    await expect(guard.authorize(join(sandboxRoot, 'tree'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_TRACKED_FILE_PROTECTED',
    });
  });

  test('protects a missing descendant of an indexed gitlink ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-resource-gitlink-'));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const sandboxRoot = join(workspaceRoot, '.wtm-resources');
    await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
    await chmod(workspaceRoot, 0o700);
    execFileSync('git', ['init', '-q', workspaceRoot], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', workspaceRoot, 'update-index', '--add', '--cacheinfo',
      `160000,${'1'.repeat(40)},.wtm-resources/vendor`,
    ], { stdio: 'ignore' });
    const guard = await createResourceGuard({ sandboxRoot, workspaceRoot, repositoryRoots: [workspaceRoot] });
    await expect(guard.authorize(join(sandboxRoot, 'vendor', 'missing', 'cache'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_TRACKED_FILE_PROTECTED',
    });
  });

  test('rechecks tracked state after an authorization hook/index swap', async () => {
    const { sandboxRoot, workspaceRoot } = await fixture();
    let tracked = false;
    const guard = await createResourceGuard({
      sandboxRoot,
      workspaceRoot,
      repositoryRoots: [workspaceRoot],
      git: { async isTracked() { return tracked; } },
    });
    const token = await guard.authorize(join(sandboxRoot, 'candidate'), 'delete');
    tracked = true;
    await expect(guard.revalidate(token)).rejects.toMatchObject({ code: 'RESOURCE_TRACKED_FILE_PROTECTED' });
  });

  test('rejects symlink components and symlink leaves without following them', async () => {
    const { guard, sandboxRoot, root } = await fixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(sandboxRoot, 'escape'));
    await symlink(join(outside, 'leaf'), join(sandboxRoot, 'leaf-link'));

    await expect(guard.authorize(join(sandboxRoot, 'escape', 'victim'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
    await expect(guard.authorize(join(sandboxRoot, 'leaf-link'), 'delete')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
  });

  test('rejects a hardlinked mutation leaf and unsafe writable parents', async () => {
    const { guard, sandboxRoot } = await fixture();
    const target = join(sandboxRoot, 'owned');
    const alias = join(sandboxRoot, 'alias');
    await writeFile(target, 'data');
    await link(target, alias);
    await expect(guard.authorize(target, 'delete')).rejects.toMatchObject({ code: 'RESOURCE_PATH_DENIED' });

    await chmod(sandboxRoot, 0o777);
    await expect(guard.authorize(join(sandboxRoot, 'next'), 'write')).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED',
    });
  });

  test('rejects sockets and other special mutation leaves', async () => {
    const { guard, sandboxRoot } = await fixture();
    const socketPath = join(sandboxRoot, 'socket');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(guard.authorize(socketPath, 'delete')).rejects.toMatchObject({ code: 'RESOURCE_PATH_DENIED' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects unresolved environment/glob syntax and targets outside the sandbox', async () => {
    const { guard, sandboxRoot, root } = await fixture();
    for (const target of [join(sandboxRoot, '$HOME'), join(sandboxRoot, '*.cache'), join(root, 'outside')]) {
      await expect(guard.authorize(target, 'write')).rejects.toMatchObject({ code: 'RESOURCE_PATH_DENIED' });
    }
  });

  test('preserves the exact parent identity across hooks and rejects a parent swap', async () => {
    const { guard, sandboxRoot } = await fixture();
    const parent = join(sandboxRoot, 'parent');
    await mkdir(parent, { mode: 0o700 });
    const token = await guard.authorize(join(parent, 'target'), 'write');
    await rm(parent, { recursive: true });
    await mkdir(parent, { mode: 0o700 });

    // Asserting the message, not only the code: on APFS a recreated directory gets a new inode
    // number and the old tuple comparison refused this too, so the code alone cannot say which
    // check answered. This one names the pin, which is the check that also holds where inode
    // numbers come back -- break `InodePin.holds` and this goes red on macOS.
    await expect(guard.revalidate(token)).rejects.toMatchObject({
      code: 'RESOURCE_PATH_DENIED', message: 'A resource parent was replaced after authorization.',
    });
  });
});
