import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceFixture, type WorkspaceFixture } from '../../../../testkit/src/workspace-fixture';
import { discoverWorkspace } from '../discover';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

describe('discoverWorkspace', () => {
  test('discovers independent repositories, a linked-worktree git file, and workspace task evidence', async () => {
    const fixture = await workspaceFixture();

    const report = await discoverWorkspace(fixture.root, { maxDepth: 5 });

    expect(report.root).toBe(fixture.root);
    expect(report.repositories.map((repository) => repository.mainRoot)).toEqual([
      fixture.firstRepoPath,
      fixture.secondRepoPath,
    ]);
    expect(report.repositories[0]?.discoveredAt).toEqual([
      fixture.firstRepoPath,
      fixture.linkedWorktreePath,
    ]);
    expect(report.repositories[0]?.worktrees.map((worktree) => worktree.path)).toEqual([
      fixture.firstRepoPath,
      fixture.linkedWorktreePath,
    ]);
    expect(report.repositories[1]?.worktrees.map((worktree) => worktree.path)).toEqual([
      fixture.secondRepoPath,
    ]);
    expect(report.taskMarkers).toContainEqual({
      kind: 'make',
      path: join(fixture.root, 'Makefile'),
      directory: fixture.root,
      workspaceLevel: true,
    });
    expect(await readFile(join(fixture.linkedWorktreePath, '.git'), 'utf8')).toStartWith('gitdir:');
  });

  test('honors maxDepth and skips generated, vendor, WTM, and worktree roots', async () => {
    const fixture = await workspaceFixture();
    for (const ignored of ['node_modules', '.wtm', '.worktrees', '.cache', 'vendor', 'dist', 'build']) {
      await mkdir(join(fixture.root, ignored, 'hidden-repo', '.git'), { recursive: true });
    }
    await mkdir(join(fixture.root, 'too', 'deep', 'repo', '.git'), { recursive: true });

    const report = await discoverWorkspace(fixture.root, { maxDepth: 1 });

    expect(report.repositories.map((repository) => repository.mainRoot)).toEqual([fixture.firstRepoPath]);
    expect(report.repositories[0]?.discoveredAt).toEqual([fixture.linkedWorktreePath]);
  });

  test('does not follow directory symlinks outside the canonical root or through cycles', async () => {
    const fixture = await workspaceFixture();
    const outside = await mkdtemp(join(tmpdir(), 'wtm-discovery-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(join(outside, 'escaped', '.git'), { recursive: true });
    await symlink(outside, join(fixture.root, 'outside-link'));
    await symlink(fixture.root, join(fixture.root, 'cycle'));

    const report = await discoverWorkspace(fixture.root, { maxDepth: 20 });

    expect(report.repositories).toHaveLength(2);
    expect(report.repositories.every((repository) => repository.mainRoot.startsWith(`${fixture.root}/`))).toBe(true);
  });

  test('continues bounded traversal below a repository to find an independent nested repo and its marker', async () => {
    const fixture = await createWorkspaceFixture({ includeNestedRepository: true });
    cleanups.push(fixture.cleanup);
    if (fixture.nestedRepoPath === null) throw new Error('Nested repository fixture was not created');

    const report = await discoverWorkspace(fixture.root, { maxDepth: 5 });

    expect(report.repositories.map((repository) => repository.mainRoot)).toEqual([
      fixture.firstRepoPath,
      fixture.nestedRepoPath,
      fixture.secondRepoPath,
    ]);
    expect(report.taskMarkers).toContainEqual({
      kind: 'javascript',
      path: join(fixture.nestedRepoPath, 'package.json'),
      directory: fixture.nestedRepoPath,
      workspaceLevel: false,
    });
  });
});

async function workspaceFixture(): Promise<WorkspaceFixture> {
  const fixture = await createWorkspaceFixture();
  cleanups.push(fixture.cleanup);
  return fixture;
}
