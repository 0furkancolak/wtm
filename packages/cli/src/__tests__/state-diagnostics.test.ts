import { describe, expect, it } from 'bun:test';
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

  it('falls back to the workspace when the command was run outside every worktree', async () => {
    expect((await sourceAt('/elsewhere').readStatus(registered)).identity.worktreeId).toBe('api-main');
  });

  it('lists every endpoint the workspace holds, across its repositories', async () => {
    const ports = await sourceAt('/workspace/web-feature').readPorts(registered);

    expect(ports.leases.map(({ name, port }) => [name, port]).sort())
      .toEqual([['api', 4100], ['web', 4200]]);
  });
});
