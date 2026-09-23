import { describe, expect, test } from 'bun:test';
import type {
  RepositoryRecord,
  StateRegistrationReader,
  WorkspaceRecord,
  WorktreeRecord,
  WorktreeState,
} from '@wtm/core';
import { featureGroup, type Registration } from '../task-resolution';

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
