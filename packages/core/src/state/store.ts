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

export interface AdapterTrustInput {
  adapterId: string;
  canonicalPath: string;
  sha256: string;
}

export interface AdapterTrustRecord extends AdapterTrustInput {
  trustedAt: string;
}

export interface AdapterTrustStateStore {
  upsertAdapterTrust(input: AdapterTrustInput): AdapterTrustRecord;
  listAdapterTrust(): AdapterTrustRecord[];
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

export interface StateStore extends AdapterTrustStateStore {
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

export interface ResourceSandboxInput {
  id: string;
  root: string;
  generation: string;
  dev: number;
  ino: number;
  uid: number;
}

export interface ResourceStorageObjectInput {
  id: string;
  sandboxId: string;
  path: string;
  dev: number;
  ino: number;
  uid: number;
  kind: 'file' | 'directory';
  state: 'READY' | 'STALE' | 'ORPHANED' | 'QUARANTINED' | 'REMOVED';
  retention: 'ephemeral' | 'persistent';
  owned: boolean;
  createdAt: string;
  lastUsedAt: string;
  lastVerifiedAt: string;
  logicalBytes: number;
  allocatedBytes: number;
}

export interface ResourceReferenceInput {
  id: string;
  storageObjectId: string;
  ownerType: string;
  ownerId: string;
  resourceName: string;
  createdAt: string;
}

export interface ResourceCleanupLeaseRequest {
  storageObjectId: string;
  sandboxId: string;
  sandboxGeneration: string;
  path: string;
  dev: number;
  ino: number;
  uid: number;
  kind: ResourceStorageObjectInput['kind'];
  state: ResourceStorageObjectInput['state'];
  retention: ResourceStorageObjectInput['retention'];
}

export interface ResourceGcEvidenceRecord extends ResourceStorageObjectInput {
  storageObjectId: string;
  sandboxRoot: string;
  sandboxGeneration: string;
  sandboxDev: number;
  sandboxIno: number;
  sandboxUid: number;
  referenceCount: number;
  cleanupLeaseToken: string | null;
}

export type ResourceGcJournalPhase = 'prepared' | 'linked' | 'unlinking' | 'quarantined' | 'deleting' | 'deleted' | 'finalized';

export interface ResourceGcJournalInput {
  operationId: string;
  storageObjectId: string;
  phase: ResourceGcJournalPhase;
  originalPath: string;
  quarantinePath: string | null;
  dev: number;
  ino: number;
  uid: number;
  sandboxId: string;
  sandboxGeneration: string;
  kind: ResourceStorageObjectInput['kind'];
  quarantineContainer: {
    path: string;
    dev: number;
    ino: number;
    uid: number;
    mode: number;
  } | null;
}

export interface ResourceLifecycleStore {
  upsertResourceSandbox(input: ResourceSandboxInput): void;
  registerResourceStorageObject(input: ResourceStorageObjectInput): void;
  addResourceReference(input: ResourceReferenceInput): void;
  releaseResourceReference(id: string, releasedAt: string): boolean;
  listResourceGcEvidence(now?: string): ResourceGcEvidenceRecord[];
  acquireResourceCleanupLease(input: ResourceCleanupLeaseRequest, token: string, ttlMs?: number): boolean;
  renewResourceCleanupLease(input: ResourceCleanupLeaseRequest, token: string, ttlMs?: number): boolean;
  releaseResourceCleanupLease(storageObjectId: string, token: string, preserveReservation?: boolean): boolean;
  finalizeResourceCleanup(storageObjectId: string, token: string): boolean;
  finalizeResourceCleanupJournal(input: ResourceGcJournalInput, token: string): boolean;
  recordResourceGcJournal(input: ResourceGcJournalInput): void;
  listResourceGcJournal(): ResourceGcJournalInput[];
}
