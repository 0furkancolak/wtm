import type { GitWorktreeRecord } from '../git/worktree-parser';

export type WorkspaceScope = 'local' | 'global-only';

export interface WorkspaceInput {
  name: string;
  root: string;
  scope: WorkspaceScope;
  configPath: string | null;
}

export interface WorkspaceRecord extends WorkspaceInput {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface RepositoryInput {
  workspaceId: string;
  commonGitDir: string;
  mainRoot: string;
  remoteIdentity: string | null;
}

export interface RepositoryRecord extends RepositoryInput {
  id: string;
  createdAt: string;
  lastReconciledAt: string | null;
}

export type WorktreeState =
  | 'DISCOVERED'
  | 'ALLOCATED'
  | 'PREPARING'
  | 'READY'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'DEGRADED'
  | 'FAILED'
  | 'ORPHANED'
  | 'CLEANING'
  | 'REMOVED'
  | 'DEGRADED_CLEANUP';

export interface WorktreeRecord {
  id: string;
  repositoryId: string;
  numericId: number;
  path: string;
  branch: string | null;
  headOid: string | null;
  isMain: boolean;
  isLocked: boolean;
  state: WorktreeState;
  createdAt: string;
  lastSeenAt: string;
  lastRuntimeAt: string | null;
}

export interface ReconcileResult {
  discovered: WorktreeRecord[];
  updated: WorktreeRecord[];
  orphaned: WorktreeRecord[];
}

export type EndpointProtocol = 'tcp' | 'udp';

export interface PortRange {
  min: number;
  max: number;
}

export interface EndpointRequest {
  worktreeId: string;
  name: string;
  protocol: EndpointProtocol;
  host: string;
  portRange: PortRange;
  preferredPort?: number;
}

export type EndpointLeaseState = 'ACTIVE' | 'RELEASED';

export interface EndpointLease {
  id: string;
  worktreeId: string;
  name: string;
  protocol: EndpointProtocol;
  host: string;
  port: number;
  state: EndpointLeaseState;
  allocatedAt: string;
  lastVerifiedAt: string;
}

export interface StateStore {
  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord;
  upsertRepository(input: RepositoryInput): RepositoryRecord;
  reconcileWorktrees(repositoryId: string, snapshot: GitWorktreeRecord[]): ReconcileResult;
  allocateEndpoint(input: EndpointRequest): EndpointLease;
  transaction<T>(fn: () => T): T;
}
