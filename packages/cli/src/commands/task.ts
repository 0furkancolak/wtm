import { stringify } from 'smol-toml';
import {
  taskOverrideListResultSchema, taskOverrideSetResultSchema, taskOverrideShowResultSchema, taskOverrideUnsetResultSchema,
  taskOverrideValueSchema,
  type JsonEnvelope, type TaskOverrideValue, type WtmError,
} from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export interface TaskFlags {
  run?: string;
  argv?: string[];
  cwd?: string;
  shell?: boolean;
  background?: boolean;
  singleton?: boolean;
  description?: string;
  env?: string[];
  /** `--worker-var`, repeated: the task's `worker_vars`. */
  workerVar?: string[];
  taskJson?: string;
}

/**
 * The task value a `wtm task set` invocation writes, built from either `--task-json` (the full
 * fidelity path an agent skill should prefer) or the individual flags below it. Returns a
 * `WtmError` rather than throwing, so the CLI action can report it the same way any other
 * invalid-argument refusal is reported.
 */
export function taskValueFromFlags(flags: TaskFlags): { value: TaskOverrideValue } | { error: WtmError } {
  if (flags.taskJson !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(flags.taskJson);
    } catch (error) {
      return { error: { code: 'WTM_CONFIG_INVALID', message: `--task-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' } };
    }
    const parsed = taskOverrideValueSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: {
        code: 'WTM_CONFIG_INVALID', message: 'Invalid task definition in --task-json.', severity: 'error',
        context: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      } };
    }
    return { value: parsed.data };
  }

  if (flags.run !== undefined && flags.argv !== undefined && flags.argv.length > 0) {
    return { error: { code: 'WTM_CONFIG_INVALID', message: '--run and --argv may not be combined.', severity: 'error' } };
  }
  const run = flags.argv !== undefined && flags.argv.length > 0 ? flags.argv : flags.run;
  const env: Record<string, string> = {};
  for (const entry of flags.env ?? []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) return { error: { code: 'WTM_CONFIG_INVALID', message: `--env expects KEY=VALUE, got "${entry}".`, severity: 'error' } };
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  const value: Record<string, unknown> = {
    ...(run === undefined ? {} : { run }),
    ...(flags.cwd === undefined ? {} : { cwd: flags.cwd }),
    ...(flags.shell === undefined ? {} : { shell: flags.shell }),
    ...(flags.background === undefined ? {} : { background: flags.background }),
    ...(flags.singleton === undefined ? {} : { singleton: flags.singleton }),
    ...(flags.description === undefined ? {} : { description: flags.description }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(flags.workerVar === undefined || flags.workerVar.length === 0 ? {} : { worker_vars: flags.workerVar }),
  };
  const parsed = taskOverrideValueSchema.safeParse(value);
  if (!parsed.success) {
    return { error: {
      code: 'WTM_CONFIG_INVALID', message: 'Invalid task definition.', severity: 'error',
      context: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    } };
  }
  return { value: parsed.data };
}

export async function runTaskListCommand(input: { cwd: string }, client?: RuntimeDaemonClient): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('task.list', { cwd: input.cwd }, client)), command: 'task list' };
  if (!envelope.ok) return envelope;
  if (!taskOverrideListResultSchema.safeParse(envelope.data).success) {
    return failure('task list', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid task list.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

export async function runTaskShowCommand(input: { cwd: string; taskName: string }, client?: RuntimeDaemonClient): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('task.show', input, client)), command: 'task show' };
  if (!envelope.ok) return envelope;
  if (!taskOverrideShowResultSchema.safeParse(envelope.data).success) {
    return failure('task show', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid task record.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

export async function runTaskSetCommand(
  input: { cwd: string; taskName: string; task: TaskOverrideValue },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('task.set', input, client)), command: 'task set' };
  if (!envelope.ok) return envelope;
  if (!taskOverrideSetResultSchema.safeParse(envelope.data).success) {
    return failure('task set', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid task record.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

export async function runTaskUnsetCommand(input: { cwd: string; taskName: string }, client?: RuntimeDaemonClient): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('task.unset', input, client)), command: 'task unset' };
  if (!envelope.ok) return envelope;
  if (!taskOverrideUnsetResultSchema.safeParse(envelope.data).success) {
    return failure('task unset', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid task unset result.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

/** `wtm task export <name>`: the same fields as `wtm.toml`, so this is the row's TOML text and nothing more. */
export function taskOverrideToToml(taskName: string, task: TaskOverrideValue): string {
  return stringify({ tasks: { [taskName]: task } });
}

function failure(command: string, error: WtmError, data: unknown = null): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: false, command, data, warnings: [], errors: [error] };
}
