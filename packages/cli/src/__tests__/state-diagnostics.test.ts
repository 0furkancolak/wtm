import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonStateStore,
  EndpointLease,
  EndpointLeaseQuery,
  RepositoryRecord,
  WorkspaceRecord,
  WorktreeRecord,
} from '@wtm/core';
import { createStateDiagnosticDataSource } from '../state-diagnostics';

const workspace: WorkspaceRecord = {
  id: 'workspace-1',
  name: 'workspace',
  root: '/workspace',
  scope: 'local',
  configPath: '/workspace/wtm.toml',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
};

const repositories: RepositoryRecord[] = [
  { id: 'api', workspaceId: 'workspace-1', commonGitDir: '/workspace/api/.git', mainRoot: '/workspace/api', remoteIdentity: null, createdAt: '2026-01-01T00:00:00.000Z', lastReconciledAt: null },
  { id: 'web', workspaceId: 'workspace-1', commonGitDir: '/workspace/web/.git', mainRoot: '/workspace/web', remoteIdentity: null, createdAt: '2026-01-01T00:00:00.000Z', lastReconciledAt: null },
];

function worktree(id: string, repositoryId: string, path: string, numericId: number): WorktreeRecord {
  return {
    id,
    repositoryId,
    numericId,
    path,
    branch: 'refs/heads/main',
    headOid: '0'.repeat(40),
    isMain: numericId === 1,
    isLocked: false,
    state: 'DISCOVERED',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    lastRuntimeAt: null,
  };
}

const worktrees = [
  worktree('api-main', 'api', '/workspace/api', 1),
  worktree('web-feature', 'web', '/workspace/web-feature', 2),
];

const leases: EndpointLease[] = [
  { id: 'lease-1', worktreeId: 'web-feature', name: 'web', protocol: 'tcp', host: '127.0.0.1', port: 4200, state: 'ACTIVE', allocatedAt: '2026-01-01T00:00:00.000Z', lastVerifiedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'lease-2', worktreeId: 'api-main', name: 'api', protocol: 'tcp', host: '127.0.0.1', port: 4100, state: 'ACTIVE', allocatedAt: '2026-01-01T00:00:00.000Z', lastVerifiedAt: '2026-01-01T00:00:00.000Z' },
];

const store = {
  listWorkspaces: () => [workspace],
  listRepositories: (workspaceId?: string) =>
    repositories.filter((repository) => workspaceId === undefined || repository.workspaceId === workspaceId),
  listWorktrees: (repositoryId?: string) =>
    worktrees.filter((record) => repositoryId === undefined || record.repositoryId === repositoryId),
  listManagedProcesses: () => [],
  listEndpointLeases: (query: EndpointLeaseQuery = {}) => leases.filter((lease) =>
    (query.worktreeIds === undefined || query.worktreeIds.includes(lease.worktreeId))
    && (query.states === undefined || query.states.includes(lease.state))),
} as unknown as DaemonStateStore;

const sourceAt = (cwd: string) => createStateDiagnosticDataSource(store, {
  cwd,
  globalConfigPath: '/workspace/config.toml',
});

const registered = { id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope } as const;

describe('registry-backed diagnostics', () => {
  it('answers for the worktree the command was run in', async () => {
    // Reporting the first registered worktree meant standing in one repository and reading
    // another repository's state back.
    const status = await sourceAt('/workspace/web-feature/src').readStatus(registered);

    expect(status.identity.worktreeId).toBe('web-feature');
    expect(status.identity.path).toBe('/workspace/web-feature');
  });

  it('shows the endpoints of the feature that worktree belongs to', async () => {
    const status = await sourceAt('/workspace/web-feature').readStatus(registered);

    // The API's port is leased against the API's worktree, and is still this feature's port.
    expect(status.endpoints.map(({ name, port }) => [name, port]).sort())
      .toEqual([['api', 4100], ['web', 4200]]);
  });

  it('answers about no worktree, rather than another one, outside every worktree', async () => {
    // Substituting a worktree is how `wtm status` inside a brand-new feature branch — one the
    // daemon has not read yet — reported `main`: its branch, its state, its ports, with
    // nothing to say the answer was about somewhere else.
    const { identity, state } = await sourceAt('/elsewhere').readStatus(registered);

    expect({ worktreeId: identity.worktreeId, branch: identity.branch, state })
      .toEqual({ worktreeId: null, branch: null, state: 'UNKNOWN' });
  });

  it('lists every endpoint the workspace holds, across its repositories', async () => {
    const ports = await sourceAt('/workspace/web-feature').readPorts(registered);

    expect(ports.leases.map(({ name, port }) => [name, port]).sort())
      .toEqual([['api', 4100], ['web', 4200]]);
  });
});

describe('doctor', () => {
  it('says which registered repositories are no longer on disk', async () => {
    // The finding that would have explained a daemon that refused to start at all.
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'git')).toEqual({
      check: 'git',
      status: 'error',
      message: '2 registered repositories no longer on disk, starting with /workspace/api. '
        + 'WTM keeps serving the rest; the registration returns on its own if the directory comes back.',
      details: { registered: 2, unavailable: 2 },
    });
  });

  it('counts the endpoints the workspace holds and the tasks it supervises', async () => {
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'ports')).toMatchObject({ status: 'pass', details: { leases: 2 } });
    expect(findings.find(({ check }) => check === 'process-records'))
      .toMatchObject({ status: 'pass', details: { running: 0 } });
  });

  it('answers every check it declares', async () => {
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.map(({ check }) => check))
      .toEqual(['git', 'config', 'adapters', 'resources', 'ports', 'process-records']);
  });

  it('says no adapter recognizes a worktree rather than saying nothing at all', async () => {
    const findings = (await sourceAt('/workspace/web-feature').readDoctor(registered)).findings;

    expect(findings.find(({ check }) => check === 'adapters')).toEqual({
      check: 'adapters',
      status: 'pass',
      message: 'No built-in adapter recognizes this worktree; only configured tasks are available.',
      details: { detected: 0, active: 0 },
    });
  });

  it('names the adapter in force, and how many tasks it contributes', async () => {
    // Which adapter won is the first question after the wrong `dev` command runs, and the
    // check that should answer it reported `unknown` no matter what was in the worktree.
    const root = mkdtempSync(join(tmpdir(), 'wtm-doctor-'));
    try {
      mkdirSync(join(root, 'repo'), { recursive: true });
      writeFileSync(join(root, 'repo/Makefile'), 'dev:\n\techo dev\n\ntest:\n\techo test\n');
      const finding = (await doctorIn(root)).find(({ check }) => check === 'adapters');

      expect(finding?.status).toBe('pass');
      expect(finding?.message).toContain('make in force');
      expect(finding?.details).toMatchObject({ detected: 1, active: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The doctor findings for a real directory, which is what adapter detection needs to read. */
async function doctorIn(root: string) {
  const local: WorkspaceRecord = { ...workspace, root, configPath: null };
  const repository: RepositoryRecord = {
    ...repositories[0] as RepositoryRecord,
    commonGitDir: join(root, 'repo/.git'),
    mainRoot: join(root, 'repo'),
  };
  const only = worktree('only', repository.id, join(root, 'repo'), 1);
  const localStore = {
    listWorkspaces: () => [local],
    listRepositories: () => [repository],
    listWorktrees: () => [only],
    listManagedProcesses: () => [],
    listEndpointLeases: () => [],
  } as unknown as DaemonStateStore;
  const source = createStateDiagnosticDataSource(localStore, {
    cwd: join(root, 'repo'),
    globalConfigPath: join(root, 'config.toml'),
  });
  return (await source.readDoctor({
    id: local.id, name: local.name, root: local.root, scope: local.scope,
  })).findings;
}
