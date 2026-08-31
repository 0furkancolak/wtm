import {
  GitCommandError,
  WorktreeAnalysisError,
} from '@wtm/core';
import type { Remediation, WtmError, WtmErrorCode } from '@wtm/protocol';

export function toGitSafetyError(error: unknown, command: string): WtmError {
  if (error instanceof GitCommandError) {
    return {
      code: 'GIT_COMMAND_FAILED',
      message: error.message,
      severity: 'error',
      context: {
        command,
        argv: [...error.argv],
        exitCode: error.exitCode,
        signal: error.signal,
        stderr: error.stderr,
      },
    };
  }
  if (error instanceof WorktreeAnalysisError) {
    return {
      code: error.code,
      message: error.message,
      severity: 'error',
      context: { ...error.context, command },
    };
  }
  if (hasErrorCode(error)) {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : 'Git safety operation failed.',
      severity: 'error',
      context: { ...readContext(error), command },
      // A refusal that knows what to do next carries it. Dropping the remediation here is how
      // `--resume` stopped being discoverable from the message that exists to suggest it.
      ...readRemediation(error),
    };
  }
  return {
    code: 'GIT_REPOSITORY_DEGRADED',
    message: error instanceof Error ? error.message.slice(0, 4096) : 'Git safety operation failed.',
    severity: 'error',
    context: { command },
  };
}

function hasErrorCode(error: unknown): error is { code: WtmErrorCode } {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return typeof error.code === 'string' && knownCodes.has(error.code as WtmErrorCode);
}

/** Only well-formed suggestions survive; a malformed one must not fail envelope validation. */
function readRemediation(error: object): { remediation?: Remediation[] } {
  if (!('remediation' in error) || !Array.isArray(error.remediation)) return {};
  const remediation = error.remediation.filter(isCommandSuggestion);
  return remediation.length === 0 ? {} : { remediation };
}

function isCommandSuggestion(value: unknown): value is Remediation {
  if (!isRecord(value) || value['kind'] !== 'command-suggestion') return false;
  const argv = value['argv'];
  return Array.isArray(argv) && argv.length > 0 && argv.every((word) => typeof word === 'string');
}

function readContext(error: object): Record<string, unknown> {
  return 'context' in error && isRecord(error.context) ? error.context : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const knownCodes: ReadonlySet<WtmErrorCode> = new Set([
  'WTM_NOT_INITIALIZED',
  'WTM_WORKSPACE_NOT_FOUND',
  'WTM_CONFIG_INVALID',
  'WTM_TEMPLATE_UNRESOLVED',
  'WTM_DAEMON_UNAVAILABLE',
  'WTM_DAEMON_INVALID_REQUEST',
  'WTM_DAEMON_PROTOCOL_INCOMPATIBLE',
  'WTM_DAEMON_REQUEST_FAILED',
  'WTM_OPERATION_CONFLICT',
  'GIT_COMMAND_FAILED',
  'GIT_REPOSITORY_DEGRADED',
  'GIT_MAIN_WORKTREE',
  'GIT_WORKTREE_LOCKED',
  'GIT_DIRTY_STAGED',
  'GIT_DIRTY_UNSTAGED',
  'GIT_UNTRACKED',
  'GIT_UNMERGED',
  'GIT_HEAD_NOT_REMOTE_PERSISTED',
  'GIT_UPSTREAM_MISSING',
  'RUNTIME_PORT_UNAVAILABLE',
  'RUNTIME_TASK_ALREADY_RUNNING',
  'RUNTIME_TASK_NOT_RUNNING',
  'RUNTIME_PROCESS_IDENTITY_STALE',
  'RUNTIME_START_FAILED',
  'RUNTIME_STOP_FAILED',
  'ADAPTER_NOT_TRUSTED',
  'ADAPTER_PROTOCOL_INCOMPATIBLE',
  'ADAPTER_TIMEOUT',
  'ADAPTER_INVALID_RESPONSE',
  'ADAPTER_DETECTION_AMBIGUOUS',
  'ADAPTER_PLAN_CONFLICT',
  'RESOURCE_PATH_DENIED',
  'RESOURCE_TRACKED_FILE_PROTECTED',
  'RESOURCE_CLEANUP_FAILED',
  'RESOURCE_CLONE_UNAVAILABLE',
  'GC_ACTIVE_WORKTREE_PROTECTED',
]);
