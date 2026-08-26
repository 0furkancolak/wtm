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
export { SQLiteStateStore } from './state/sqlite-store';
export type {
  EndpointLease,
  EndpointLeaseState,
  EndpointProtocol,
  EndpointRequest,
  PortRange,
  ReconcileResult,
  RepositoryInput,
  RepositoryRecord,
  StateStore,
  WorkspaceInput,
  WorkspaceRecord,
  WorkspaceScope,
  WorktreeRecord,
  WorktreeState,
} from './state/store';
export * from './workspace/index';
