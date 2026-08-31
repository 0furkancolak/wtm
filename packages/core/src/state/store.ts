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

export interface EndpointLeaseQuery {
  /** Restricts the answer to the endpoints these worktrees hold. An empty list matches nothing. */
  worktreeIds?: readonly string[];
  name?: string;
  states?: readonly EndpointLeaseState[];
}

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

/** The destructive operations that take a repository-wide lease before they start. */
export type RepositoryOperation = 'remove' | 'gc' | 'repair';

export interface RepositoryOperationLeaseKey {
  repositoryId: string;
  operation: RepositoryOperation;
}

/**
 * What a colliding lease says about the process holding it. This is the diagnostic view, and
 * it deliberately carries no token: reading a lease must not hand out the capability to
 * release it.
 */
export interface RepositoryOperationLeaseHolder {
  repositoryId: string;
  operation: RepositoryOperation;
  pid: number;
  /** The verbatim `ps -o lstart=` string, so a recycled PID cannot pass for the holder. */
  processStartTime: string;
  subjectWorktreeId: string | null;
  /** The last stage the holder recorded, which is where a resumed operation continues from. */
  stage: string | null;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface RepositoryOperationLease extends RepositoryOperationLeaseHolder {
  token: string;
}

export type RepositoryOperationLeaseResult =
  /** `adoptedStage` is the stage an adopted lease had reached, and null for a fresh one. */
  | { outcome: 'acquired'; lease: RepositoryOperationLease; adoptedStage: string | null }
  | { outcome: 'conflict'; holder: RepositoryOperationLeaseHolder }
  | { outcome: 'abandoned'; holder: RepositoryOperationLeaseHolder };

export interface RepositoryOperationLeaseRequest {
  repositoryId: string;
  operation: RepositoryOperation;
  token: string;
  pid: number;
  processStartTime: string;
  subjectWorktreeId?: string | undefined;
  ttlMs: number;
  /** Takes over an abandoned lease instead of reporting it. This is the `--resume` path. */
  adopt?: boolean | undefined;
  /**
   * Whether the process holding a colliding, expired lease is still alive. The store cannot
   * run `ps`, and core must not spawn one per row, so the verdict is the caller's — computed
   * inside the transaction for the single row the acquisition collides with, and only when
   * that row has already expired.
   */
  ownerLiveness?: ((holder: RepositoryOperationLeaseHolder) => 'alive' | 'gone') | undefined;
}

export interface StateStore extends AdapterTrustStateStore {
  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord;
  upsertRepository(input: RepositoryInput): RepositoryRecord;
  reconcileWorktrees(repositoryId: string, snapshot: GitWorktreeRecord[]): ReconcileResult;
  allocateEndpoint(input: EndpointRequest, probe?: EndpointAvailabilityProbe): EndpointLease;
  listEndpointLeases(query?: EndpointLeaseQuery): EndpointLease[];
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
  /**
   * Claims the repository for one destructive operation, or reports who holds it.
   *
   * A lapsed TTL is not evidence that the holder is gone: an expired lease whose owner
   * `ownerLiveness` reports `alive` is still a conflict. An expired lease whose owner is gone
   * is reported `abandoned` rather than taken, because continuing a half-done cleanup is only
   * safe for a caller that asked to resume one — `adopt` is what takes it over.
   */
  acquireRepositoryOperationLease(
    input: RepositoryOperationLeaseRequest,
    now: string,
  ): RepositoryOperationLeaseResult;
  /** Extends a lease the caller still holds. An expired lease is re-acquired, never renewed. */
  renewRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    now: string,
    ttlMs: number,
  ): boolean;
  /** Records how far the operation has got, so an interrupted one can be resumed from there. */
  advanceRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    stage: string,
    now: string,
  ): boolean;
  releaseRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string): boolean;
  readRepositoryOperationLease(key: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null;
  /**
   * Releases every active endpoint lease of one worktree, and reports how many it released.
   *
   * Reconciliation releases the ports of a worktree Git no longer reports, which is too late
   * for a removal: the ports have to be verifiably given back *before* Git deletes the
   * directory. The two paths are idempotent with respect to each other.
   */
  releaseEndpointLeasesForWorktree(worktreeId: string, releasedAt: string): number;
  transaction<T>(fn: () => T): T;
}

export interface StateRegistrationReader {
  listWorkspaces(): WorkspaceRecord[];
  listRepositories(workspaceId?: string): RepositoryRecord[];
  listWorktrees(repositoryId?: string): WorktreeRecord[];
}

/** Retiring a registration whose directory is not coming back. */
export interface StateRegistrationWriter {
  /** Removes the workspace and everything that exists only because of it. */
  forgetWorkspace(workspaceId: string): boolean;
  /** Removes one repository and everything that exists only because of it. */
  forgetRepository(repositoryId: string): boolean;
}

/** What a once-only lifecycle event can be about. */
export type LifecycleEventSubject = 'workspace' | 'repository' | 'worktree';

export interface LifecycleEventStore {
  /** True when this call is the one that announced the event for this subject. */
  claimLifecycleEvent(
    subjectType: LifecycleEventSubject,
    subjectId: string,
    event: string,
    now?: string,
  ): boolean;
  /** Withdraws an announcement that could not be carried out, so a later pass can retry it. */
  releaseLifecycleEvent(subjectType: LifecycleEventSubject, subjectId: string, event: string): boolean;
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
