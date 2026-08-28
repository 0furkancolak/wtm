import type { DaemonStateStore, WorkspaceRecord } from '@wtm/core';
import type { DiagnosticDataSource, RegisteredWorkspace, StatusDiagnostic } from './diagnostics';

export function createStateDiagnosticDataSource(store: DaemonStateStore): DiagnosticDataSource {
  const registered = (workspace: WorkspaceRecord): RegisteredWorkspace => ({
    id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope,
  });
  return {
    listRegisteredWorkspaces: async () => store.listWorkspaces().map(registered),
    readStatus: async (workspace) => {
      const repositoryIds = new Set(store.listRepositories(workspace.id).map(({ id }) => id));
      const worktree = store.listWorktrees().find(({ repositoryId }) => repositoryIds.has(repositoryId));
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
        endpoints: [],
        processes,
        resources: [],
      } satisfies StatusDiagnostic;
    },
    readDoctor: async (workspace) => ({ workspace, findings: [] }),
    readExplain: async (workspace) => ({ workspace, decisions: [] }),
    readPlan: async (workspace) => ({ workspace, changes: [] }),
    readEnv: async (workspace) => ({ workspace, variables: {} }),
    readPorts: async (workspace) => ({ workspace, leases: [] }),
  };
}
