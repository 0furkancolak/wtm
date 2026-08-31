import { afterEach, describe, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import * as core from '../../index';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import type { ResourceConfig } from '../../config/schema';
import {
  removeWorktreeGuarded,
  removeWorktreeGuardedWithHooks,
  removeWorktreeSafely,
  removeWorktreeSafelyWithHooks,
  type RemovalRuntimeCoordinator,
} from '../remove-worktree';

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

  test('still blocks that commit when runtime cleanup runs between the two analyses', async () => {
    const fixture = await createFixture();
    const stages: string[] = [];
    const coordinator: RemovalRuntimeCoordinator = {
      async reclaimablePaths() {
        stages.push('reclaimable-paths');
        return [];
      },
      async stopManagedProcesses() {
        stages.push('stop-processes');
        return { stopped: 1 };
      },
      async verifyManagedProcessesStopped() {
        stages.push('verify-processes');
        return { active: 0, cleanupOwed: 0 };
      },
      async cleanupEphemeralResources() {
        stages.push('cleanup-resources');
        return { collected: 0, retained: [] };
      },
      async releaseEndpointLeases() {
        stages.push('release-endpoints');
        return { released: 1 };
      },
      async reconcile() {
        stages.push('reconcile');
      },
    };

    const removal = removeWorktreeGuardedWithHooks({
      context: { ...context(fixture), repositoryId: 'repository-1', worktreeId: 'worktree-7' },
      coordinator,
    }, {
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
    // The window the re-analysis closes now contains the cleanup stages, so the blocker has to
    // survive them; `reconcile` never runs because Git never deleted anything. The initial
    // analysis was clean, so nothing was deferred and the coordinator was never asked what it
    // could reclaim.
    expect(stages).toEqual(['stop-processes', 'verify-processes', 'cleanup-resources', 'release-endpoints']);
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

describe('a blocker that only names what WTM materialized', () => {
  for (const visibility of ['untracked', 'gitignored'] as const) {
    test(`removes a worktree whose ephemeral resource directory is ${visibility}`, async () => {
      const fixture = await createFixture();
      await materializeEphemeralResource(fixture, visibility);

      const result = await removeWorktreeGuarded({
        context: runtimeContext(fixture),
        coordinator: resourceCleanupCoordinator(fixture),
      });

      // The directory WTM created is what the cleanup stage exists to collect, so the removal
      // has to reach that stage rather than refuse in front of it.
      expect(result.cleanup.collectedResources).toBe(1);
      expect(result.deferredBlockers.map((blocker) => blocker.code)).toEqual(['GIT_UNTRACKED']);
      expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
    });
  }

  test('still refuses an untracked file the cleanup stage would not collect', async () => {
    const fixture = await createFixture();
    await materializeEphemeralResource(fixture, 'untracked');
    await fixture.write(fixture.linkedWorktreePath, 'scratch.md', 'notes worth keeping\n');

    const removal = removeWorktreeGuarded({
      context: runtimeContext(fixture),
      coordinator: resourceCleanupCoordinator(fixture),
    });

    await expect(removal).rejects.toMatchObject({
      name: 'WorktreeRemovalBlockedError',
      blockers: [{ code: 'GIT_UNTRACKED' }],
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });

  test('refuses without a coordinator, which is the Git-only path unchanged', async () => {
    const fixture = await createFixture();
    await materializeEphemeralResource(fixture, 'untracked');

    // Nothing here knows what a resource is, so `node_modules` is untracked content like any
    // other and the removal refuses. Deferral is a property of the runtime path alone.
    await expect(removeWorktreeSafely(context(fixture))).rejects.toMatchObject({
      name: 'WorktreeRemovalBlockedError',
      blockers: [{ code: 'GIT_UNTRACKED', context: { paths: ['node_modules/.package-lock.json'] } }],
    });
    expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  });
});

const ephemeralResources: Record<string, ResourceConfig> = {
  node_modules: { path: 'node_modules', policy: 'ephemeral' },
};

/** A `node_modules` WTM materialized, as `prepareResources` would leave it in a worktree. */
async function materializeEphemeralResource(
  fixture: GitSafetyFixture,
  visibility: 'untracked' | 'gitignored',
): Promise<void> {
  await fixture.write(fixture.linkedWorktreePath, 'node_modules/.package-lock.json', '{}\n');
  if (visibility === 'untracked') return;
  // Ignored and untracked reach the analysis by different `git status` records and both fold
  // into the same blocker, so a fix that only understands one of them is only half a fix.
  await fixture.write(fixture.linkedWorktreePath, '.gitignore', 'node_modules/\n');
  await fixture.git(fixture.linkedWorktreePath, ['add', '.gitignore']);
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Ignore node_modules']);
  await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
}

/**
 * The production shape of the port: the same declarations answer `reclaimablePaths` and drive
 * the cleanup, so a test cannot pass by promising a path the cleanup would not have collected.
 */
function resourceCleanupCoordinator(fixture: GitSafetyFixture): RemovalRuntimeCoordinator {
  const input = { worktreeRoot: fixture.linkedWorktreePath, resources: ephemeralResources };
  return {
    async reclaimablePaths() {
      return core.reclaimableWorktreeResourcePaths(input);
    },
    async stopManagedProcesses() {
      return { stopped: 0 };
    },
    async verifyManagedProcessesStopped() {
      return { active: 0, cleanupOwed: 0 };
    },
    async cleanupEphemeralResources() {
      const cleanup = await core.cleanupWorktreeEphemeralResources(input);
      return { collected: cleanup.collected, retained: cleanup.retained };
    },
    async releaseEndpointLeases() {
      return { released: 0 };
    },
    async reconcile() {
      // Nothing to reconcile: this coordinator holds no state database.
    },
  };
}

function runtimeContext(fixture: GitSafetyFixture) {
  return { ...context(fixture), repositoryId: 'repository-1', worktreeId: 'worktree-7' };
}

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
