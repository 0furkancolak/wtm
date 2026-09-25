import {
  resolveTask,
  WtmTemplateError,
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
      errors: [unleasedEndpointError(error, input) ?? toRuntimeCommandError(error, 'resolve', input.taskName)],
    };
  }
}

/**
 * `wtm resolve` answers from the leases the feature already holds and never takes one: a report
 * that allocates is a report whose answer is whatever it just decided, and a later `resolve`
 * after a release decided something else. An endpoint the configuration declares but nothing has
 * leased yet is therefore a normal state here, and "unable to resolve {port.web}" read like a
 * typo in the configuration.
 */
function unleasedEndpointError(error: unknown, input: ResolveCommandInput): WtmError | null {
  if (!(error instanceof WtmTemplateError)) return null;
  const variable = error.context['variable'];
  if (typeof variable !== 'string' || !variable.startsWith('port.')) return null;
  const endpoint = variable.slice('port.'.length);
  const declared = input.config.ports?.[endpoint];
  if (typeof declared !== 'object' || declared === null) return null;
  return {
    code: 'WTM_TEMPLATE_UNRESOLVED',
    message: `Endpoint ${endpoint} has no port leased yet for this feature. \`wtm resolve\` reports the `
      + `ports a feature holds and never takes one; \`wtm start ${input.taskName}\` or \`wtm run ${input.taskName}\` `
      + 'leases every endpoint of the feature.',
    severity: 'error',
    context: { variable, endpoint, command: 'resolve', taskName: input.taskName },
    remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'start', input.taskName] }],
  };
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
