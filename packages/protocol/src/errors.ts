import { z } from 'zod';

export const errorSeveritySchema = z.enum(['info', 'warning', 'error']);

export const wtmErrorCodeSchema = z.enum([
  'WTM_NOT_INITIALIZED', 'WTM_WORKSPACE_NOT_FOUND', 'WTM_CONFIG_INVALID', 'WTM_TEMPLATE_UNRESOLVED', 'WTM_DAEMON_UNAVAILABLE', 'WTM_DAEMON_INVALID_REQUEST', 'WTM_DAEMON_PROTOCOL_INCOMPATIBLE', 'WTM_DAEMON_REQUEST_FAILED', 'WTM_OPERATION_CONFLICT',
  'GIT_COMMAND_FAILED', 'GIT_REPOSITORY_DEGRADED', 'GIT_MAIN_WORKTREE', 'GIT_WORKTREE_LOCKED', 'GIT_DIRTY_STAGED', 'GIT_DIRTY_UNSTAGED', 'GIT_UNTRACKED', 'GIT_UNMERGED', 'GIT_HEAD_NOT_REMOTE_PERSISTED', 'GIT_UPSTREAM_MISSING',
  'RUNTIME_PORT_UNAVAILABLE', 'RUNTIME_TASK_ALREADY_RUNNING', 'RUNTIME_TASK_NOT_RUNNING', 'RUNTIME_PROCESS_IDENTITY_STALE', 'RUNTIME_START_FAILED', 'RUNTIME_STOP_FAILED',
  'ADAPTER_NOT_TRUSTED', 'ADAPTER_PROTOCOL_INCOMPATIBLE', 'ADAPTER_TIMEOUT', 'ADAPTER_INVALID_RESPONSE', 'ADAPTER_DETECTION_AMBIGUOUS', 'ADAPTER_PLAN_CONFLICT',
  'RESOURCE_PATH_DENIED', 'RESOURCE_TRACKED_FILE_PROTECTED', 'RESOURCE_CLEANUP_FAILED', 'RESOURCE_CLONE_UNAVAILABLE', 'GC_ACTIVE_WORKTREE_PROTECTED',
]);

export const commandSuggestionRemediationSchema = z.object({
  kind: z.literal('command-suggestion'),
  argv: z.array(z.string()).min(1),
}).strict();

export const remediationSchema = z.discriminatedUnion('kind', [
  commandSuggestionRemediationSchema,
]);

export const wtmErrorSchema = z.object({
  code: wtmErrorCodeSchema,
  message: z.string().min(1),
  severity: errorSeveritySchema,
  context: z.record(z.string(), z.unknown()).optional(),
  remediation: z.array(remediationSchema).optional(),
}).strict();

export type ErrorSeverity = z.infer<typeof errorSeveritySchema>;
export type WtmErrorCode = z.infer<typeof wtmErrorCodeSchema>;
export type Remediation = z.infer<typeof remediationSchema>;
export type WtmError = z.infer<typeof wtmErrorSchema>;
