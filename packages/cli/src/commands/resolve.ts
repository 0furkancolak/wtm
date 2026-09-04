import {
  resolveTask,
  type ResolvedTask,
  type TaskResolutionInput,
} from '@wtm/core';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';

export interface ResolveCommandInput extends TaskResolutionInput {
  workspaceId?: string;
}

export type ResolveCommandEnvelope = JsonEnvelope<ResolvedTask | null>;

export async function runResolveCommand(input: ResolveCommandInput): Promise<ResolveCommandEnvelope> {
  try {
    return {
      schemaVersion: 1,
      ok: true,
      command: 'resolve',
      scope: commandScope(input),
      data: resolveTask(input),
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'resolve',
      scope: commandScope(input),
      data: null,
      warnings: [],
      errors: [toRuntimeCommandError(error, 'resolve', input.taskName)],
    };
  }
}

export function toRuntimeCommandError(
  error: unknown,
  command: 'resolve' | 'run',
  taskName: string,
  extraContext: Record<string, unknown> = {},
): WtmError {
  return {
    code: runtimeErrorCode(error, command),
    message: error instanceof Error ? error.message : String(error),
    severity: 'error',
    context: {
      ...errorContext(error),
      ...extraContext,
      command,
      taskName,
    },
  };
}

export function commandScope(input: { workspaceId?: string }): { mode: 'local'; workspaceId?: string } {
  return {
    mode: 'local',
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
}

function runtimeErrorCode(error: unknown, command: 'resolve' | 'run'): WtmErrorCode {
  if (hasStringCode(error)) {
    if (
      error.code === 'WTM_CONFIG_INVALID'
      || error.code === 'WTM_TEMPLATE_UNRESOLVED'
      || error.code === 'RUNTIME_PORT_UNAVAILABLE'
      || error.code === 'RUNTIME_START_FAILED'
      // Standing outside every worktree WTM knows about -- including a multi-repo workspace
      // root that is not itself a Git repository -- is not a configuration defect, so it must
      // survive this mapping rather than being folded into `WTM_CONFIG_INVALID`.
      || error.code === 'WTM_WORKSPACE_NOT_FOUND'
    ) return error.code;
  }
  return command === 'run' ? 'RUNTIME_START_FAILED' : 'WTM_CONFIG_INVALID';
}

function errorContext(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null || !('context' in error)) return {};
  return isRecord(error.context) ? error.context : {};
}

function hasStringCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
