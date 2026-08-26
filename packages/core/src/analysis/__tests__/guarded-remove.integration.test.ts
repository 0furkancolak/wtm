import { afterEach, describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import * as core from '../../index';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { removeWorktreeSafely, removeWorktreeSafelyWithHooks } from '../remove-worktree';

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('removeWorktreeSafely', () => {
  test('rechecks after the initial analysis and blocks a newly created local-only commit', async () => {
    const fixture = await createFixture();

    const removal = removeWorktreeSafelyWithHooks(context(fixture), {
      async afterInitialAnalysis() {
        await fixture.write(fixture.linkedWorktreePath, 'late-local.txt', 'created in TOCTOU window\n');
        await fixture.git(fixture.linkedWorktreePath, ['add', 'late-local.txt']);
        await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Late local-only commit']);
      },
    });

    await expect(removal).rejects.toMatchObject({
      name: 'WorktreeRemovalBlockedError',
      blockers: [{ code: 'GIT_HEAD_NOT_REMOTE_PERSISTED' }],
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });

  test('serializes removal guards by canonical repository identity', async () => {
    const fixture = await createFixture();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondAcquired = false;
    let firstHolding!: () => void;
    const firstHoldsMutex = new Promise<void>((resolve) => {
      firstHolding = resolve;
    });
    let secondQueued!: () => void;
    const secondIsQueued = new Promise<void>((resolve) => {
      secondQueued = resolve;
    });

    const first = removeWorktreeSafelyWithHooks(context(fixture), {
      async afterInitialAnalysis() {
        firstHolding();
        await firstCanFinish;
        throw new Error('release first guard without removing');
      },
    });
    await firstHoldsMutex;
    const second = removeWorktreeSafelyWithHooks({
      ...context(fixture),
      repoPath: fixture.linkedWorktreePath,
    }, {
      onMutexWait() {
        secondQueued();
      },
      afterMutexAcquired() {
        secondAcquired = true;
      },
    });

    await secondIsQueued;
    expect(secondAcquired).toBe(false);
    releaseFirst();
    await expect(first).rejects.toThrow('release first guard without removing');
    await expect(second).resolves.toMatchObject({ identity: { path: fixture.linkedWorktreePath } });
  });

  test('releases the repository mutex when the post-acquire hook throws', async () => {
    const fixture = await createFixture();

    await expect(removeWorktreeSafelyWithHooks(context(fixture), {
      afterMutexAcquired() {
        throw new Error('injected post-acquire failure');
      },
    })).rejects.toThrow('injected post-acquire failure');

    await expect(removeWorktreeSafely(context(fixture))).resolves.toMatchObject({
      identity: { path: fixture.linkedWorktreePath },
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
  }, 2_000);

  test('safely removes a clean remote-persisted linked worktree attached to a bare repository', async () => {
    const fixture = await createFixture();
    const bareLinkedPath = `${fixture.root}/bare-safe-linked`;
    await fixture.git(fixture.remotePath, ['remote', 'add', 'origin', fixture.repoPath]);
    await fixture.git(fixture.remotePath, [
      'worktree', 'add', '-b', 'feature/bare-safe', bareLinkedPath, 'main',
    ]);
    await fixture.git(bareLinkedPath, ['push', '-u', 'origin', 'feature/bare-safe']);

    await expect(removeWorktreeSafely({
      repoPath: fixture.remotePath,
      worktreePath: bareLinkedPath,
      baseRef: 'refs/heads/main',
    })).resolves.toMatchObject({ identity: { isMain: false, path: bareLinkedPath } });
    expect(await pathExists(bareLinkedPath)).toBe(false);
  });

  test('does not expose the raw Git removal primitive from the core root', () => {
    expect('removeGitWorktree' in core).toBe(false);
    expect('runGit' in core).toBe(false);
  });
});

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

function context(fixture: GitSafetyFixture) {
  return {
    repoPath: fixture.repoPath,
    worktreePath: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
