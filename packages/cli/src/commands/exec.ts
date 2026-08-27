import { spawn } from 'node:child_process';
import type { JsonEnvelope } from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export type { RuntimeDaemonClient } from './runtime-client';

export interface PreparedExec {
  argv: string[];
  cwd: string;
  envDelta: Record<string, string>;
}

export interface ForegroundExecutionInput extends PreparedExec {
  shell: false;
}

export type ForegroundExecutor = (
  input: ForegroundExecutionInput,
) => Promise<{ exitCode: number; signal: NodeJS.Signals | null }>;

export async function runExecCommand(
  input: { cwd: string; argv: string[] },
  client?: RuntimeDaemonClient,
  execute: ForegroundExecutor = executeRawForeground,
): Promise<JsonEnvelope<unknown>> {
  const preparedEnvelope = await requestRuntimeCommand('exec', input, client);
  if (!preparedEnvelope.ok) return preparedEnvelope;
  const prepared = parsePreparedExec(preparedEnvelope.data);
  if (prepared === null) return invalidExecResponse();
  try {
    const result = await execute({ ...prepared, shell: false });
    if (result.exitCode !== 0 || result.signal !== null) {
      return {
        schemaVersion: 1,
        ok: false,
        command: 'exec',
        data: null,
        warnings: [],
        errors: [{
          code: 'RUNTIME_START_FAILED',
          message: 'Foreground command exited unsuccessfully.',
          severity: 'error',
          context: { command: 'exec', exitCode: result.exitCode, signal: result.signal },
        }],
      };
    }
    return {
      schemaVersion: 1,
      ok: true,
      command: 'exec',
      data: { ...prepared, ...result },
      warnings: preparedEnvelope.warnings,
      errors: [],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command: 'exec',
      data: null,
      warnings: [],
      errors: [{
        code: 'RUNTIME_START_FAILED',
        message: 'Foreground command could not be started.',
        severity: 'error',
        context: { command: 'exec', reason: safeErrorCode(error) },
      }],
    };
  }
}

export async function executeRawForeground(
  input: ForegroundExecutionInput,
): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> {
  const executable = input.argv[0];
  if (executable === undefined) throw new Error('Foreground command is empty');
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, input.argv.slice(1), {
      cwd: input.cwd,
      env: { ...process.env, ...input.envDelta },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
  });
}

function parsePreparedExec(value: unknown): PreparedExec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.argv) || record.argv.length === 0 || !record.argv.every((item) => typeof item === 'string')) {
    return null;
  }
  if (typeof record.cwd !== 'string' || !isStringRecord(record.envDelta)) return null;
  return { argv: record.argv, cwd: record.cwd, envDelta: record.envDelta };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

function invalidExecResponse(): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'exec',
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_DAEMON_REQUEST_FAILED',
      message: 'WTM daemon returned an invalid exec response.',
      severity: 'error',
      context: { command: 'exec' },
    }],
  };
}

function safeErrorCode(error: unknown): string {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}
