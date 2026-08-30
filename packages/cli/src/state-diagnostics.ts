import { relative, resolve, sep } from 'node:path';
import type { DaemonStateStore, WorkspaceRecord, WorktreeRecord } from '@wtm/core';
import { execEnvironment, resolveWorktreeRuntime } from '@wtm/daemon';
import type { DiagnosticDataSource, RegisteredWorkspace, StatusDiagnostic } from './diagnostics';

export interface StateDiagnosticOptions {
  /** The directory the command was run in, which is what decides *which* worktree it is about. */
  cwd: string;
  globalConfigPath: string;
}

export function createStateDiagnosticDataSource(
  store: DaemonStateStore,
  options: StateDiagnosticOptions,
): DiagnosticDataSource {
  const registered = (workspace: WorkspaceRecord): RegisteredWorkspace => ({
    id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope,
  });

  /**
   * The worktree the question is about. `status` used to answer for whichever worktree the
   * registry happened to list first, so standing in one branch's directory reported another
   * branch's state — and in a workspace of several repositories, another repository's.
   */
  const currentWorktree = (workspaceId: string): WorktreeRecord | undefined => {
    const worktrees = workspaceWorktrees(workspaceId);
    const containing = worktrees
      .filter((worktree) => contains(worktree.path, options.cwd))
      .sort((left, right) => right.path.length - left.path.length)[0];
    return containing ?? worktrees[0];
  };

  /** Every worktree of this workspace that shares the given worktree's branch. */
  const featureWorktreeIds = (workspaceId: string, worktree: WorktreeRecord): string[] => {
    if (worktree.branch === null) return [worktree.id];
    return workspaceWorktrees(workspaceId)
      .filter((candidate) => candidate.branch === worktree.branch)
      .map(({ id }) => id);
  };

  const workspaceWorktrees = (workspaceId: string): WorktreeRecord[] => {
    const repositoryIds = new Set(store.listRepositories(workspaceId).map(({ id }) => id));
    return store.listWorktrees().filter(({ repositoryId }) => repositoryIds.has(repositoryId));
  };

  return {
    listRegisteredWorkspaces: async () => store.listWorkspaces().map(registered),
    readStatus: async (workspace) => {
      const worktree = currentWorktree(workspace.id);
      const processes = worktree === undefined ? [] : store.listManagedProcesses({ worktreeId: worktree.id }).map((process) => ({
        task: process.taskName,
        pid: process.state === 'RUNNING' ? process.pid : null,
        state: process.state === 'RUNNING' ? 'running' as const : process.state === 'STALE_IDENTITY' ? 'stale' as const : 'stopped' as const,
        startedAt: process.startedAt,
        argv: [],
      }));
      return {
        workspace,
        identity: worktree === undefined ? {
          repositoryId: null, worktreeId: null, numericId: null, path: workspace.root,
          branch: null, headOid: null, isMain: true,
        } : {
          repositoryId: worktree.repositoryId,
          worktreeId: worktree.id,
          numericId: worktree.numericId,
          path: worktree.path,
          branch: worktree.branch,
          headOid: worktree.headOid,
          isMain: worktree.isMain,
        },
        state: worktree?.state ?? 'UNKNOWN',
        // A feature's endpoints are leased once for every repository that shares its branch,
        // so listing only this worktree's own leases shows nothing at all to the repository
        // that reads the other's port.
        endpoints: worktree === undefined ? [] : store.listEndpointLeases({
          worktreeIds: featureWorktreeIds(workspace.id, worktree),
          states: ['ACTIVE'],
        }),
        processes,
        resources: [],
      } satisfies StatusDiagnostic;
    },
    readDoctor: async (workspace) => ({ workspace, findings: [] }),
    readExplain: async (workspace) => ({ workspace, decisions: [] }),
    readPlan: async (workspace) => ({ workspace, changes: [] }),
    readEnv: async (workspace) => ({
      workspace,
      // Resolving allocates whatever this worktree is owed, which is the only way the answer
      // can name the port a task would actually be started with.
      variables: execEnvironment(await resolveWorktreeRuntime({
        store,
        cwd: options.cwd,
        globalConfigPath: options.globalConfigPath,
      })),
    }),
    readPorts: async (workspace) => ({
      workspace,
      leases: store.listEndpointLeases({
        worktreeIds: workspaceWorktrees(workspace.id).map(({ id }) => id),
        states: ['ACTIVE'],
      }),
    }),
  };
}

function contains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..');
}
