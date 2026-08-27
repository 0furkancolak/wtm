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

export interface EndpointCandidate {
  protocol: EndpointProtocol;
  host: string;
  port: number;
}

export type EndpointAvailabilityProbe = (candidate: EndpointCandidate) => boolean;

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

export type ManagedProcessState =
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'
  | 'STALE_IDENTITY';

export interface ManagedProcessInput {
  worktreeId: string;
  taskName: string;
  pid: number;
  pgid: number;
  processStartTime: string;
  commandFingerprint: string;
  state: ManagedProcessState;
  startedAt: string;
  stoppedAt: string | null;
  stdoutPath: string;
  stderrPath: string;
  cleanupRequired?: boolean;
  cleanupOwnerToken?: string;
}

export interface ManagedProcessRecord extends Omit<ManagedProcessInput, 'cleanupRequired'> {
  id: string;
  cleanupRequired: boolean;
}

export interface ManagedProcessUpdate {
  expectedStates: readonly ManagedProcessState[];
  state: ManagedProcessState;
  stoppedAt?: string | null;
  reservationToken?: string;
  cleanupRequired?: boolean;
}

export interface ManagedProcessCreateOptions {
  reservationToken?: string;
}

export interface ManagedProcessReservationOptions {
  expiresAt?: string;
  replaceProcessId?: string;
}

export interface ManagedProcessQuery {
  worktreeId?: string;
  taskName?: string;
  states?: readonly ManagedProcessState[];
}

export interface StateStore {
  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord;
  upsertRepository(input: RepositoryInput): RepositoryRecord;
  reconcileWorktrees(repositoryId: string, snapshot: GitWorktreeRecord[]): ReconcileResult;
  allocateEndpoint(input: EndpointRequest, probe?: EndpointAvailabilityProbe): EndpointLease;
  createManagedProcess(input: ManagedProcessInput, options?: ManagedProcessCreateOptions): ManagedProcessRecord;
  getManagedProcess(id: string): ManagedProcessRecord | null;
  updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null;
  listManagedProcesses(query?: ManagedProcessQuery): ManagedProcessRecord[];
  findActiveManagedProcess(worktreeId: string, taskName: string): ManagedProcessRecord | null;
  reserveManagedProcessStart(
    worktreeId: string,
    taskName: string,
    token: string,
    createdAt: string,
    options?: ManagedProcessReservationOptions,
  ): boolean;
  releaseManagedProcessStart(worktreeId: string, taskName: string, token: string): boolean;
  releaseExpiredManagedProcessStart(worktreeId: string, taskName: string, now: string): boolean;
  releaseExpiredManagedProcessReplacement(record: ManagedProcessRecord, now: string): boolean;
  hasManagedProcessStartReservation(worktreeId: string, taskName: string): boolean;
  transaction<T>(fn: () => T): T;
}

export interface StateRegistrationReader {
  listWorkspaces(): WorkspaceRecord[];
  listRepositories(workspaceId?: string): RepositoryRecord[];
  listWorktrees(repositoryId?: string): WorktreeRecord[];
}

export type DaemonStateStore = StateStore & StateRegistrationReader;
