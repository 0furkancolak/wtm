export {
  GitCommandError,
  defaultGitTimeoutMs,
  listGitWorktrees,
  readGitRemoteOrigin,
  readGitRepositoryIdentity,
  remoteFetchTimeoutMs,
  retriedWorktreeListTimeoutMs,
  worktreeListTimeoutMs,
} from './git/git-runner';
export type { GitCommandOptions, GitCommandResult, GitRepositoryIdentity } from './git/git-runner';
export { parseGitWorktreePorcelain } from './git/worktree-parser';
export { containsPath } from './paths/contains';
export {
  DaemonSocketPathTooLongError,
  assertDaemonSocketPathFits,
  boundDaemonSocketPath,
  daemonDataDirectorySegments,
  daemonDataRoot,
  daemonSocketFileName,
  daemonSocketPathLimitBytes,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from './paths/daemon-socket';
export type { DaemonSocketPathMeasurement } from './paths/daemon-socket';
export type { GitWorktreeRecord } from './git/worktree-parser';
export {
  analyzeWorktree,
  parseStatusPorcelainV2,
  WorktreeAnalysisError,
} from './analysis/worktree-analysis';
export type {
  BaseAnalysis,
  UpstreamAnalysis,
  WorkingTreeAnalysis,
  WorkingTreeClassification,
  RemoteKnowledge,
  RemoteRefreshRecord,
  WorktreeAnalysis,
  WorktreeContext,
  WorktreeIdentityAnalysis,
  WorktreeSafety,
} from './analysis/worktree-analysis';
export {
  analyzeRemotePersistence,
  defaultAllowedRemoteRefs,
  parseNulFormattedRefs,
  refreshRemoteTrackingRefs,
} from './analysis/remote-persistence';
export type { RemotePersistenceAnalysis, RemoteRefreshResult } from './analysis/remote-persistence';
export { assertRemovable, WorktreeRemovalBlockedError } from './analysis/remove-policy';
export {
  ManagedProcessResidueError,
  removalStages,
  removeWorktreeGuarded,
  removeWorktreeSafely,
} from './analysis/remove-worktree';
export type {
  EndpointReleaseReport,
  EphemeralCleanupReport,
  GuardedRemovalInput,
  GuardedRemovalResult,
  ManagedProcessResidue,
  RemovalRuntimeCoordinator,
  RemovalStage,
  RemovalSubject,
  StoppedProcessesReport,
} from './analysis/remove-worktree';
export {
  defaultOperationLeaseTtlMs,
  RepositoryOperationConflictError,
  withRepositoryOperationLease,
} from './analysis/operation-lease';
export type {
  RepositoryOperationConflictDetail,
  RepositoryOperationLeaseInput,
  RepositoryOperationLeaseStore,
  RepositoryOperationSession,
} from './analysis/operation-lease';
export { resolveWorkspaceConfig, builtInConfig } from './config/load';
export { mergeConfigLayers } from './config/merge';
export { parseWtmConfig, wtmConfigSchema, WtmConfigError } from './config/schema';
export type { CorsConfig, PortConfig, PortsConfig, RepoConfig, ResourceConfig, WtmConfig } from './config/schema';
export { repoEnvironment, resolveRepoScope } from './config/repos';
export type { RepoScopeInput, ResolvedRepoScope } from './config/repos';
export type { ResolvedConfig, Provenance } from './config/provenance';
export { resolveTemplate, WtmTemplateError } from './templates/resolve';
export type { TemplateContext } from './templates/resolve';
export {
  installProcessStartIdentityReader,
  readProcessStartIdentity,
} from './runtime/process-identity';
export type { ProcessStartIdentity, ProcessStartTimeReader } from './runtime/process-identity';
export { resolveEnvironment, WtmEnvironmentError } from './runtime/environment';
export type { EnvironmentResolutionInput } from './runtime/environment';
export { resolveTask, WtmTaskResolutionError } from './runtime/task-resolver';
export type { ResolvedTask, TaskResolutionInput } from './runtime/task-resolver';
export {
  allocateStableEndpoint,
  installEndpointProbe,
  isEndpointAvailable,
  spawnedEndpointProbe,
  WtmEndpointAllocationError,
} from './runtime/endpoints';
export { probeEndpoint, runEndpointProbe } from './runtime/endpoint-probe';
export {
  defaultEndpointHost,
  defaultOriginHost,
  parsePortRange,
  resolveEndpoints,
  resolveExistingEndpoints,
} from './runtime/endpoint-plan';
export type { EndpointPlanInput, ObservedEndpoint, ResolvedEndpoints } from './runtime/endpoint-plan';
export { corsDeclarationFiles, corsVariablePattern, detectCorsVariables, resolveCors } from './runtime/cors';
export type { CorsResolutionInput, ResolvedCors } from './runtime/cors';
export { declarationFiles, exampleDeclarationFiles, readDeclaredNames, readEnvDeclarations } from './detect/declarations';
export type { EnvDeclaration } from './detect/declarations';
export { composeFiles, parseComposeServices, readComposeFile } from './detect/compose';
export type { ComposeFileReport, ComposeService } from './detect/compose';
export { detectWorkspaceServices } from './detect/service-detection';
export type {
  DetectedLink,
  DetectedPort,
  DetectedService,
  DetectionConfidence,
  DetectionEvidence,
  DetectWorkspaceInput,
  WorkspaceDetection,
} from './detect/service-detection';
export { renderConfigDraft } from './detect/config-draft';
export type { ConfigDraft, ConfigDraftBlock, ConfigDraftInput, OutOfRangePort } from './detect/config-draft';
export { SQLiteStateStore } from './state/sqlite-store';
export { ensurePrivateDirectory, PrivateDirectoryError, verifyPrivateDirectory } from './state/private-directory';
export type { PrivateDirectory, PrivateDirectoryIdentity } from './state/private-directory';
export type {
  EndpointLease,
  EndpointLeaseQuery,
  EndpointLeaseState,
  EndpointAvailabilityProbe,
  EndpointCandidate,
  EndpointProtocol,
  EndpointRequest,
  ManagedProcessInput,
  ManagedProcessCreateOptions,
  ManagedProcessQuery,
  ManagedProcessRecord,
  ManagedProcessReservationOptions,
  ManagedProcessState,
  ManagedProcessUpdate,
  DaemonStateStore,
  PortRange,
  ReconcileResult,
  RepositoryInput,
  RepositoryOperation,
  RepositoryOperationLease,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseRequest,
  RepositoryOperationLeaseResult,
  RepositoryRecord,
  StateStore,
  LifecycleEventStore,
  LifecycleEventSubject,
  StateRegistrationReader,
  StateRegistrationWriter,
  WorkspaceInput,
  WorkspaceRecord,
  WorkspaceScope,
  WorktreeRecord,
  WorktreeState,
  ResourceGcEvidenceRecord,
  ResourceCleanupLeaseRequest,
  ResourceGcJournalInput,
  ResourceGcJournalPhase,
  ResourceLifecycleStore,
  ResourceReferenceInput,
  ResourceSandboxInput,
  ResourceStorageObjectInput,
} from './state/store';
export * from './workspace/index';
export {
  ResourcePathGuardError,
  authorizeResourcePath,
  createResourceGuard,
} from './resources/guard';
export type {
  GitTrackingInspector,
  ResourceGuard,
  ResourceGuardIntent,
  ResourceGuardOptions,
  ResourcePathAuthorization,
} from './resources/guard';
export {
  ResourceMaterializationError,
  applyMaterializationPlan,
  buildMaterializationPlan,
  planResourceMaterialization,
} from './resources/materializer';
export type {
  ApplyMaterializationOptions,
  CloneFileCapability,
  MaterializationHooks,
  MaterializationPlan,
  MaterializationRequest,
  MaterializationResult,
} from './resources/materializer';
export { inspectResources, prepareResources } from './resources/preparation';
export type { PreparedResource, ResourcePreparationInput, ResourceState } from './resources/preparation';
export {
  cleanupWorktreeEphemeralResources,
  reclaimableWorktreeResourcePaths,
} from './resources/removal';
export type {
  WorktreeResourceCleanupInput,
  WorktreeResourceCleanupResult,
  WorktreeResourceDisposition,
  WorktreeResourceOutcome,
} from './resources/removal';
export { applyGcPlan, buildGcPlan, executeGcPlan, planResourceGc, recoverGcJournalEntry } from './resources/gc';
export type {
  ApplyGcOptions,
  BuildGcPlanInput,
  GcApplyResult,
  GcCandidate,
  GcEvidence,
  GcExclusionReason,
  GcHooks,
  GcItemResult,
  GcJournal,
  GcJournalEntry,
  GcJournalPhase,
  GcLeaseCoordinator,
  GcPlan,
  ResourceSandboxIdentity,
  RecoverGcOptions,
} from './resources/gc';
export {
  AdapterTrustError,
  createAdapterTrustStore,
  createSqliteAdapterTrustStore,
  inspectAdapterExecutable,
  trustRepositoryAdapter,
  verifyTrustedRepositoryAdapter,
} from './plan/adapter-trust';
export type {
  AdapterExecutableIdentity,
  AdapterTrustRecord,
  AdapterTrustStore,
  TrustRepositoryAdapterInput,
} from './plan/adapter-trust';
export { ExternalAdapterError, invokeExternalAdapter } from './plan/external-adapter';
export type { ExternalAdapterHooks, ExternalAdapterInvocation } from './plan/external-adapter';
