import { initializeWorkspace, type InitInput, type InitResult } from '@wtm/core';
import type { JsonEnvelope, WtmError, WtmErrorCode } from '@wtm/protocol';

export type InitCommandEnvelope = JsonEnvelope<InitResult | null>;

export async function runInitCommand(input: InitInput): Promise<InitCommandEnvelope> {
  const mode = input.globalOnly === true ? 'global' as const : 'local' as const;
  try {
    const result = await initializeWorkspace(input);
    return {
      schemaVersion: 1,
      ok: true,
      command: 'init',
      scope: { mode, workspaceId: result.workspace.id },
      data: result,
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'init',
      scope: { mode },
      data: null,
      warnings: [],
      errors: [toInitError(error)],
    };
  }
}

function toInitError(error: unknown): WtmError {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return {
    code,
    message,
    severity: 'error',
    context: { ...errorContext(error), command: 'init' },
  };
}

function errorCode(error: unknown): WtmErrorCode {
  if (hasStringCode(error)) {
    if (error.code === 'WTM_CONFIG_INVALID' || error.code === 'GIT_COMMAND_FAILED') return error.code;
  }
  return 'WTM_CONFIG_INVALID';
}

function errorContext(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const context = 'context' in error && isRecord(error.context) ? error.context : {};
  if (!hasStringCode(error) || error.code !== 'GIT_COMMAND_FAILED') return context;
  return {
    ...context,
    ...('argv' in error && Array.isArray(error.argv) ? { argv: error.argv } : {}),
    ...('exitCode' in error ? { exitCode: error.exitCode } : {}),
    ...('signal' in error ? { signal: error.signal } : {}),
    ...('stderr' in error && typeof error.stderr === 'string' ? { stderr: error.stderr } : {}),
  };
}

function hasStringCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
