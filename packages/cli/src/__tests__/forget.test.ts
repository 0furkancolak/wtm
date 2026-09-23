import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { join as posixJoin } from 'node:path/posix';
import { join as win32Join } from 'node:path/win32';
import { HeavyJobError, type RepositoryRecord, type WorkspaceRecord, type WorktreeRecord } from '@wtm/core';
import { runForgetCommand } from '../commands/forget';

function workspace(name: string, root: string): WorkspaceRecord {
  return {
    id: `workspace-${name}`, name, root, scope: 'local', configPath: null,
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Most roots in this file are POSIX-shaped fixtures injected regardless of the host, so they have
 * to join with `path/posix` — the default `join` follows the host and produced a `mainRoot` no
 * POSIX selector below could match on a real windows-latest leg. One root is not a fixture: the
 * "still on disk" test needs a directory that exists, so it gets a real `mkdtemp` path in the
 * host's own spelling. Joining *that* with `path/posix` was the other half of the same mistake,
 * and is what made the Windows leg compare `…\wtm-forget-x/repo` against `…\wtm-forget-x\repo`.
 *
 * So the flavour follows the root rather than the file.
 */
const win32Rooted = /^[a-zA-Z]:[\\/]|^\\\\/;

function joinBeneath(root: string, ...segments: string[]): string {
  return win32Rooted.test(root) ? win32Join(root, ...segments) : posixJoin(root, ...segments);
}

function createStore(workspaces: WorkspaceRecord[]) {
  const forgotten: string[] = [];
  const repositories: RepositoryRecord[] = workspaces.map((item) => ({
    id: `repository-${item.name}`,
    workspaceId: item.id,
    commonGitDir: joinBeneath(item.root, 'repo', '.git'),
    mainRoot: joinBeneath(item.root, 'repo'),
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

  it('reports the ambiguity, not a plain no-match, when a name is shared by two workspaces', async () => {
    const shared = [
      workspace('shared', '/projects/one/shared'),
      { ...workspace('shared', '/projects/two/shared'), id: 'workspace-shared-2' },
    ];
    const { store, forgotten } = createStore(shared);

    const envelope = await runForgetCommand({ store, cwd: '/elsewhere', selector: 'shared' });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_WORKSPACE_NOT_FOUND');
    expect(envelope.errors[0]?.message).toContain('matches 2 registered workspaces');
    expect(envelope.errors[0]?.message).not.toContain('No registered workspace or repository matches');
    expect(envelope.errors[0]?.context).toEqual({
      selector: 'shared',
      matches: [
        { id: 'workspace-shared', name: 'shared', root: '/projects/one/shared' },
        { id: 'workspace-shared-2', name: 'shared', root: '/projects/two/shared' },
      ],
    });
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

  /**
   * The selector used to be read as absolute only when it began with `/`, and joined onto the
   * working directory with a `/` of its own otherwise. An absolute path in the host's own spelling
   * is the case that breaks: on Windows it begins with a drive letter, so it was read as relative
   * and glued onto the cwd, naming nothing — and `forget` silently widened to the containing
   * workspace, which retires more than the caller asked for.
   *
   * Written in the host's spelling rather than a POSIX literal, so it is the *host* that decides
   * what an absolute path looks like here.
   */
  it('reaches the repository through an absolute selector in the spelling this host uses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-forget-absolute-'));
    try {
      const { store, forgotten } = createStore([workspace('live', root)]);

      const envelope = await runForgetCommand({
        store, cwd: tmpdir(), selector: join(root, 'repo'), force: true,
      });

      expect(envelope.errors).toEqual([]);
      expect(envelope.data?.target).toBe('repository');
      expect(forgotten).toEqual(['repository-live']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reaches the same repository through a relative selector', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-forget-relative-'));
    try {
      const { store, forgotten } = createStore([workspace('live', root)]);

      const envelope = await runForgetCommand({ store, cwd: root, selector: 'repo', force: true });

      expect(envelope.errors).toEqual([]);
      expect(envelope.data?.target).toBe('repository');
      expect(forgotten).toEqual(['repository-live']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `forgetWorkspace`/`forgetRepository` refuse a live repository-operation lease by throwing
   * `HeavyJobError` from deep inside the same transaction that would otherwise delete the lease
   * row a concurrent `remove`/`gc`/`create` depends on. Left uncaught, that throw would escape
   * `runForgetCommand` as a bare exception instead of the `ok: false` envelope every other
   * `forget` refusal returns.
   */
  it('turns a live-operation-lease refusal into a failure envelope instead of throwing', async () => {
    const { store, forgotten } = createStore([workspace('busy', '/projects/gone/busy')]);
    const guarded = {
      ...store,
      forgetWorkspace: (id: string) => {
        forgotten.push(id);
        throw new HeavyJobError(
          'WTM_OPERATION_CONFLICT',
          'Repository has a live "remove" operation (pid 4242); wait for it to finish before forgetting.',
          { repositoryId: 'repository-busy', operation: 'remove', holderPid: 4242 },
        );
      },
    };

    const envelope = await runForgetCommand({ store: guarded, cwd: '/anywhere', selector: 'busy' });

    expect(envelope.ok).toBe(false);
    expect(envelope.errors[0]?.code).toBe('WTM_OPERATION_CONFLICT');
    expect(envelope.errors[0]?.message).toContain('live "remove" operation');
    expect(envelope.errors[0]?.context).toMatchObject({ operation: 'remove', holderPid: 4242 });
  });

  it('lets an unrelated exception propagate rather than swallowing it as a forget failure', async () => {
    const { store } = createStore([workspace('busy', '/projects/gone/busy')]);
    const broken = {
      ...store,
      forgetWorkspace: () => { throw new TypeError('unexpected'); },
    };

    await expect(runForgetCommand({ store: broken, cwd: '/anywhere', selector: 'busy' }))
      .rejects.toThrow('unexpected');
  });
});
