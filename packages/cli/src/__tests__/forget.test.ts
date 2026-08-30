import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepositoryRecord, WorkspaceRecord, WorktreeRecord } from '@wtm/core';
import { runForgetCommand } from '../commands/forget';

function workspace(name: string, root: string): WorkspaceRecord {
  return {
    id: `workspace-${name}`, name, root, scope: 'local', configPath: null,
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
}

function createStore(workspaces: WorkspaceRecord[]) {
  const forgotten: string[] = [];
  const repositories: RepositoryRecord[] = workspaces.map((item) => ({
    id: `repository-${item.name}`,
    workspaceId: item.id,
    commonGitDir: join(item.root, 'repo/.git'),
    mainRoot: join(item.root, 'repo'),
    remoteIdentity: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastReconciledAt: null,
  }));
  const worktrees: WorktreeRecord[] = repositories.map((item, index) => ({
    id: `worktree-${index}`,
    repositoryId: item.id,
    numericId: 1,
    path: item.mainRoot,
    branch: 'refs/heads/main',
    headOid: 'head',
    isMain: true,
    isLocked: false,
    state: 'READY',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    lastRuntimeAt: null,
  }));
  return {
    forgotten,
    store: {
      listWorkspaces: () => workspaces,
      listRepositories: (workspaceId?: string) => repositories
        .filter((item) => workspaceId === undefined || item.workspaceId === workspaceId),
      listWorktrees: () => worktrees,
      forgetWorkspace: (id: string) => {
        forgotten.push(id);
        return workspaces.some((item) => item.id === id);
      },
      forgetRepository: (id: string) => {
        forgotten.push(id);
        return repositories.some((item) => item.id === id);
      },
    },
  };
}

describe('wtm forget', () => {
  it('retires the workspace whose directory is gone, and says what went with it', async () => {
    const { store, forgotten } = createStore([workspace('old', '/projects/gone/old')]);

    const envelope = await runForgetCommand({ store, cwd: '/anywhere', selector: 'old' });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      target: 'workspace',
      workspace: { id: 'workspace-old', name: 'old', root: '/projects/gone/old' },
      repository: null,
      repositories: 1,
      worktrees: 1,
      rootMissing: true,
    });
    expect(forgotten).toEqual(['workspace-old']);
  });

  it('refuses a workspace that is still on disk, and names the flag that would do it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-forget-'));
    try {
      const { store, forgotten } = createStore([workspace('live', root)]);

      const envelope = await runForgetCommand({ store, cwd: root });

      expect(envelope.ok).toBe(false);
      expect(envelope.errors[0]?.message).toContain('is still on disk');
      expect(envelope.errors[0]?.remediation)
        .toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'forget', 'live', '--force'] }]);
      expect(forgotten).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retires a workspace that is still on disk when told to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-forget-'));
    try {
      const { store, forgotten } = createStore([workspace('live', root)]);

      const envelope = await runForgetCommand({ store, cwd: root, force: true });

      expect(envelope.ok).toBe(true);
      expect(envelope.data?.rootMissing).toBe(false);
      expect(forgotten).toEqual(['workspace-live']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports that nothing matches rather than retiring the wrong workspace', async () => {
    const { store, forgotten } = createStore([workspace('old', '/projects/gone/old')]);

    const envelope = await runForgetCommand({ store, cwd: '/elsewhere', selector: 'other' });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_WORKSPACE_NOT_FOUND');
    expect(forgotten).toEqual([]);
  });

  it('needs a selector when the current directory is in no workspace', async () => {
    const { store } = createStore([workspace('old', '/projects/gone/old')]);

    const envelope = await runForgetCommand({ store, cwd: '/elsewhere' });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.message).toContain('nothing was named');
  });

  it('retires one repository whose directory is gone without touching its live workspace', async () => {
    // The instrument that existed was workspace-sized, and this workspace is in daily use: six
    // finished migrations could be reported forever or taken out along with everything else.
    const { store, forgotten } = createStore([workspace('migrations', '/projects/migrations')]);

    const envelope = await runForgetCommand({
      store, cwd: '/projects/migrations', selector: '/projects/migrations/repo',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      target: 'repository',
      workspace: { id: 'workspace-migrations', name: 'migrations', root: '/projects/migrations' },
      repository: { id: 'repository-migrations', mainRoot: '/projects/migrations/repo' },
      repositories: 1,
      worktrees: 1,
      rootMissing: true,
    });
    expect(forgotten).toEqual(['repository-migrations']);
  });

  it('retires the workspace, not one repository, when the path is the workspace root', async () => {
    // Retiring the repository alone would leave a registered workspace with nothing in it, and
    // every command answering about a workspace that no longer contains anything.
    const { store, forgotten } = createStore([workspace('single', '/projects/single')]);

    const envelope = await runForgetCommand({
      store, cwd: '/elsewhere', selector: '/projects/single',
    });

    expect(envelope.data?.target).toBe('workspace');
    expect(forgotten).toEqual(['workspace-single']);
  });

  it('refuses a repository that is still on disk, and names the path that would do it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-forget-'));
    try {
      mkdirSync(join(root, 'repo'));
      const { store, forgotten } = createStore([workspace('live', root)]);

      const envelope = await runForgetCommand({ store, cwd: root, selector: join(root, 'repo') });

      expect(envelope.ok).toBe(false);
      expect(envelope.errors[0]?.message).toContain('Retiring a repository that exists');
      expect(envelope.errors[0]?.remediation)
        .toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'forget', join(root, 'repo'), '--force'] }]);
      expect(forgotten).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
