export {
  GitCommandError,
  listGitWorktrees,
  readGitRemoteOrigin,
  readGitRepositoryIdentity,
} from './git/git-runner';
export type { GitCommandOptions, GitCommandResult, GitRepositoryIdentity } from './git/git-runner';
export { parseGitWorktreePorcelain } from './git/worktree-parser';
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
  WorktreeAnalysis,
  WorktreeContext,
  WorktreeIdentityAnalysis,
  WorktreeSafety,
} from './analysis/worktree-analysis';
export {
  analyzeRemotePersistence,
  defaultAllowedRemoteRefs,
  parseNulFormattedRefs,
} from './analysis/remote-persistence';
export type { RemotePersistenceAnalysis } from './analysis/remote-persistence';
export { assertRemovable, WorktreeRemovalBlockedError } from './analysis/remove-policy';
export { removeWorktreeSafely } from './analysis/remove-worktree';
export { resolveWorkspaceConfig, builtInConfig } from './config/load';
export { mergeConfigLayers } from './config/merge';
export { parseWtmConfig, wtmConfigSchema, WtmConfigError } from './config/schema';
export type { WtmConfig } from './config/schema';
export type { ResolvedConfig, Provenance } from './config/provenance';
export { resolveTemplate, WtmTemplateError } from './templates/resolve';
export type { TemplateContext } from './templates/resolve';
export { resolveEnvironment, WtmEnvironmentError } from './runtime/environment';
export type { EnvironmentResolutionInput } from './runtime/environment';
export { resolveTask, WtmTaskResolutionError } from './runtime/task-resolver';
export type { ResolvedTask, TaskResolutionInput } from './runtime/task-resolver';
export {
  allocateStableEndpoint,
  isEndpointAvailable,
  WtmEndpointAllocationError,
} from './runtime/endpoints';
export { SQLiteStateStore } from './state/sqlite-store';
export { ensurePrivateDirectory, PrivateDirectoryError, verifyPrivateDirectory } from './state/private-directory';
export type { PrivateDirectory, PrivateDirectoryIdentity } from './state/private-directory';
export type {
  EndpointLease,
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
  RepositoryRecord,
  StateStore,
  StateRegistrationReader,
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
