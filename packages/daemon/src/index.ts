export { UnixIpcServer } from './server';
export type { IpcRequestHandler, UnixIpcServerOptions } from './server';
export { WtmDaemon, assertSupportedRuntime } from './main';
export type {
  DaemonRecoveryHooks,
  DaemonRegistrationSnapshot,
  DaemonProcessSupervisorLifecycle,
  DaemonServerLifecycle,
  DaemonWatcherLifecycle,
  ReconciledRepository,
  WtmDaemonOptions,
} from './main';
export { ReconcilerQueue } from './reconciler-queue';
export type {
  ReconcileBatch,
  ReconcileSignal,
  ReconcileSignalKind,
  ReconcilerClock,
  ReconcilerQueueOptions,
} from './reconciler-queue';
export { StructuralWatcher, structuralWatchMarkerNames } from './watcher';
export type {
  RepositoryWatchRegistration,
  StructuralWatcherOptions,
  WatchHandle,
  WorkspaceWatchRegistration,
} from './watcher';
export { ManagedLogStore } from './logs';
export type { ManagedLogStoreOptions, OpenedManagedLogs } from './logs';
export {
  ManagedProcessError,
  ManagedProcessSupervisor,
  inspectProcess,
  inspectProcessGroup,
  inspectProcessIdentity,
} from './process-supervisor';
export type {
  ManagedProcessSelector,
  ManagedProcessStartInput,
  ManagedProcessStartResult,
  ManagedProcessStateStore,
  ManagedProcessSupervisorOptions,
  ProcessGroupInspection,
  ProcessIdentity,
  ProcessInspection,
} from './process-supervisor';
export { LifecycleEventDispatcher, lifecycleEventNames } from './events';
export type {
  LifecycleDispatchResult,
  LifecycleEventDispatch,
  LifecycleEventDispatcherOptions,
  LifecycleEventName,
  LifecycleTaskOutcome,
} from './events';
export { inspectAdapters } from './adapter-report';
export type { AdapterInspection, AdapterReport } from './adapter-report';
export { DaemonRegistrationError, DaemonRuntimeController, runtimeCommandNames } from './runtime-controller';
export type {
  DaemonRuntimeControllerOptions,
  DaemonRuntimeLogReader,
  DaemonRuntimeResolver,
  DaemonRuntimeSupervisor,
} from './runtime-controller';
export { createProductionDaemon, defaultProductionRuntimePaths } from './runtime-factory';
export {
  adapterContext,
  branchName,
  execEnvironment,
  featureGroup,
  findRegistration,
  inspectRuntimeResources,
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
  templateContext,
} from './task-resolution';
export type { Registration, WorktreeRuntime, WorktreeRuntimeInput } from './task-resolution';
export type {
  ProductionDaemonOptions,
  ProductionDaemonRuntime,
  ProductionRuntimePaths,
} from './runtime-factory';
export {
  LaunchdLifecycleError,
  createLaunchdLifecycle,
  generateLaunchdPlist,
  launchdCommands,
  launchdLabel,
  launchdPaths,
  sanitizeLaunchdPathEnvironment,
} from './launchd';
export type {
  LaunchdCommandResult,
  LaunchdCommandRunner,
  LaunchdCommandSet,
  LaunchdInstallState,
  LaunchdLifecycle,
  LaunchdLifecycleOptions,
  LaunchdLifecycleResult,
  LaunchdPaths,
  LaunchdPlistOptions,
  LaunchdProcessInspection,
  LaunchdProcessInspector,
  LaunchdStatusState,
  LaunchdTransactionPhase,
  LaunchdUninstallState,
} from './launchd';
