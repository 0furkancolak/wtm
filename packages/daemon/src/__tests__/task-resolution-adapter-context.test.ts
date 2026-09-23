import { describe, expect, it } from 'bun:test';
import { adapterContext } from '../task-resolution';

describe('adapterContext', () => {
  it('reports the main checkout for repository.root, not the linked worktree being operated on', () => {
    // docs/06-adapter-protocol.md's own "Detection" example sets repository.root equal to
    // repository.mainRoot (the main checkout) and gives worktree.root as the separate, differing
    // path for a linked worktree -- e.g. repository.root "/Users/me/dev/app" alongside
    // worktree.root "/Users/me/dev/.worktrees/app-auth". An adapter that follows that documented
    // contract to locate repo-wide state not replicated into every worktree (a shared cache, a
    // root-level config) must not silently receive the worktree path instead.
    const context = adapterContext({
      workspace: {
        id: 'workspace-1',
        name: 'app',
        root: '/Users/me/dev',
        scope: 'local',
        configPath: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
      repository: {
        id: 'repository-1',
        workspaceId: 'workspace-1',
        commonGitDir: '/Users/me/dev/app/.git',
        mainRoot: '/Users/me/dev/app',
        remoteIdentity: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastReconciledAt: null,
      },
      worktree: {
        id: 'worktree-1',
        repositoryId: 'repository-1',
        numericId: 7,
        path: '/Users/me/dev/.worktrees/app-auth',
        branch: 'feat/auth',
        headOid: null,
        isMain: false,
        isLocked: false,
        state: 'READY',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
        lastRuntimeAt: null,
      },
    });

    expect(context.repository).toEqual({ root: '/Users/me/dev/app', mainRoot: '/Users/me/dev/app' });
    expect(context.worktree.root).toBe('/Users/me/dev/.worktrees/app-auth');
  });
});
