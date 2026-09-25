import { describe, expect, test } from 'bun:test';
import type {
  RepositoryRecord,
  StateRegistrationReader,
  WorkspaceRecord,
  WorktreeRecord,
  WorktreeState,
} from '@wtm/core';
import { featureGroup, findRegistration, leaseOwner, type Registration } from '../task-resolution';

const workspace: WorkspaceRecord = {
  id: 'workspace-1', name: 'demo', root: '/projects/demo', scope: 'local',
  configPath: '/projects/demo/wtm.toml', createdAt: '2026-09-23T00:00:00.000Z', lastSeenAt: '2026-09-23T00:00:00.000Z',
};

function repository(id: string, path: string): RepositoryRecord {
  return {
    id, workspaceId: workspace.id, commonGitDir: `${path}/.git`, mainRoot: path, remoteIdentity: null,
    createdAt: '2026-09-23T00:00:00.000Z', lastReconciledAt: null,
  };
}

function worktree(
  id: string, repositoryId: string, path: string, branch: string | null, state: WorktreeState = 'READY',
): WorktreeRecord {
  return {
    id, repositoryId, numericId: 1, path, branch, headOid: 'head', isMain: true, isLocked: false, state,
    createdAt: '2026-09-23T00:00:00.000Z', lastSeenAt: '2026-09-23T00:00:00.000Z', lastRuntimeAt: null,
  };
}

function fakeStore(repositories: RepositoryRecord[], worktrees: WorktreeRecord[]): StateRegistrationReader {
  return {
    listWorkspaces: () => [workspace],
    listRepositories: () => repositories,
    listWorktrees: () => worktrees,
  };
}

describe('featureGroup', () => {
  test('keeps a live sibling in the same branch across repositories', () => {
    const api = repository('repo-api', '/projects/demo/api');
    const web = repository('repo-web', '/projects/demo/web');
    const apiWorktree = worktree('worktree-api', api.id, '/projects/demo/api', 'feature', 'RUNNING');
    const webWorktree = worktree('worktree-web', web.id, '/projects/demo/web', 'feature', 'READY');
    const store = fakeStore([api, web], [apiWorktree, webWorktree]);
    const registration: Registration = { workspace, repository: api, worktree: apiWorktree };

    expect(featureGroup(store, registration).map(({ id }) => id)).toEqual(['worktree-api', 'worktree-web']);
  });

  test('drops an orphaned sibling instead of leaving it eligible to hold the group\'s leases forever', () => {
    // Once a group member is gone (`ORPHANED` after `reconcileWorktrees` no longer sees it, or
    // `REMOVED`/`CLEANING`/`DEGRADED_CLEANUP` mid-teardown), it must stop being a candidate for
    // `resolveWorktreeRuntime`'s `owner` -- otherwise every future resolution of the surviving
    // worktree keeps attaching new shared leases to a worktree that is never coming back.
    const api = repository('repo-api', '/projects/demo/api');
    const web = repository('repo-web', '/projects/demo/web');
    const apiWorktree = worktree('worktree-api', api.id, '/projects/demo/api', 'feature', 'ORPHANED');
    const webWorktree = worktree('worktree-web', web.id, '/projects/demo/web', 'feature', 'RUNNING');
    const store = fakeStore([api, web], [apiWorktree, webWorktree]);
    // Resolving *for the surviving worktree* -- the removed one is a sibling in this call, not
    // the registration's own worktree, so it gets no exemption.
    const registration: Registration = { workspace, repository: web, worktree: webWorktree };

    expect(featureGroup(store, registration).map(({ id }) => id)).toEqual(['worktree-web']);
  });

  test('drops a sibling mid-teardown, not only one `reconcileWorktrees` has already settled', () => {
    // `CLEANING` is what a removal sets on its own worktree before `git worktree remove` runs
    // (`removal-coordinator.ts`'s `releaseEndpointLeases`) -- well before `reconcileWorktrees`
    // gets a chance to settle it to `ORPHANED`/`REMOVED`. A concurrent resolution against a live
    // sibling, during that whole window, must not still treat the worktree being removed as a
    // candidate for the group's shared endpoint lease: `allocateStableEndpoint` (`endpoint-plan.ts`)
    // would attach a fresh lease to a worktree whose directory is already gone, which
    // `reconcileWorktrees` then silently releases once it notices -- splitting the group's shared
    // endpoint between a live process and a lease nothing points at.
    const api = repository('repo-api', '/projects/demo/api');
    const web = repository('repo-web', '/projects/demo/web');
    const apiWorktree = worktree('worktree-api', api.id, '/projects/demo/api', 'feature', 'CLEANING');
    const webWorktree = worktree('worktree-web', web.id, '/projects/demo/web', 'feature', 'RUNNING');
    const store = fakeStore([api, web], [apiWorktree, webWorktree]);
    const registration: Registration = { workspace, repository: web, worktree: webWorktree };

    expect(featureGroup(store, registration).map(({ id }) => id)).toEqual(['worktree-web']);
  });

  test('keeps the registration\'s own worktree even in a dead state', () => {
    // A caller resolving *against* the removed worktree itself (e.g. mid-removal, before its row
    // is deleted) must still get itself back -- only siblings are filtered.
    const api = repository('repo-api', '/projects/demo/api');
    const apiWorktree = worktree('worktree-api', api.id, '/projects/demo/api', 'feature', 'REMOVED');
    const store = fakeStore([api], [apiWorktree]);
    const registration: Registration = { workspace, repository: api, worktree: apiWorktree };

    expect(featureGroup(store, registration).map(({ id }) => id)).toEqual(['worktree-api']);
  });

  test('a worktree on no branch is its own group without consulting the store', () => {
    const api = repository('repo-api', '/projects/demo/api');
    const apiWorktree = worktree('worktree-api', api.id, '/projects/demo/api', null);
    const registration: Registration = { workspace, repository: api, worktree: apiWorktree };

    expect(featureGroup(fakeStore([], []), registration)).toEqual([apiWorktree]);
  });
});

describe('leaseOwner', () => {
  test('never hands the group\'s leases to a dead worktree, even when it sorts first', () => {
    // A shell whose working directory still spells a renamed worktree's old path resolves to the
    // old, ORPHANED row. `featureGroup` keeps it (it is the caller), and it sorts first -- so it
    // became the owner, new leases landed on it, and the next reconcile released them from under
    // the feature's running tasks.
    const api = repository('repo-api', '/projects/demo/api');
    const web = repository('repo-web', '/projects/demo/web');
    const stale = worktree('worktree-old', api.id, '/projects/demo/.worktrees/ecw-1-api', 'feature', 'ORPHANED');
    const live = worktree('worktree-api', api.id, '/projects/demo/.worktrees/ECW-1-api', 'feature', 'RUNNING');
    const webWorktree = worktree('worktree-web', web.id, '/projects/demo/.worktrees/ECW-1-web', 'feature', 'READY');
    const registration: Registration = { workspace, repository: api, worktree: stale };
    const group = featureGroup(fakeStore([api, web], [stale, live, webWorktree]), registration);

    expect(group[0]?.id).toBe('worktree-old');
    expect(leaseOwner(group, registration).id).toBe('worktree-api');
  });

  test('falls back to the registration\'s own worktree when nothing in the group is live', () => {
    const api = repository('repo-api', '/projects/demo/api');
    const stale = worktree('worktree-old', api.id, '/projects/demo/api-old', 'feature', 'ORPHANED');
    const registration: Registration = { workspace, repository: api, worktree: stale };

    expect(leaseOwner([stale], registration).id).toBe('worktree-old');
  });
});

describe('findRegistration', () => {
  const api = repository('repo-api', '/projects/demo/api');
  const stale = worktree('worktree-old', api.id, '/projects/demo/.worktrees/ecw-1-api', 'feature', 'ORPHANED');
  const live = worktree('worktree-api', api.id, '/projects/demo/.worktrees/ECW-1-api', 'feature', 'RUNNING');
  // What a case-insensitive filesystem's real path says about a directory whose case changed.
  const canonical = (path: string) => path.replace('/ecw-1-api', '/ECW-1-api');

  test('answers from the live worktree when the directory was reached through a stale spelling of its path', () => {
    expect(findRegistration(fakeStore([api], [stale, live]), '/projects/demo/.worktrees/ecw-1-api/src', canonical).worktree.id)
      .toBe('worktree-api');
  });

  test('still answers with a dead worktree when no live one is the same directory', () => {
    expect(findRegistration(fakeStore([api], [stale]), '/projects/demo/.worktrees/ecw-1-api', canonical).worktree.id)
      .toBe('worktree-old');
    expect(findRegistration(fakeStore([api], [stale, live]), '/projects/demo/.worktrees/ecw-1-api', () => null).worktree.id)
      .toBe('worktree-old');
  });
});
