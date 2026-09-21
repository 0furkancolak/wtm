import {
  checklistClearResultSchema, checklistListResultSchema, checklistSetResultSchema,
  type JsonEnvelope,
} from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export async function runChecklistListCommand(input: { cwd: string }, client?: RuntimeDaemonClient): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('checklist.list', { cwd: input.cwd }, client)), command: 'checklist list' };
  if (!envelope.ok) return envelope;
  if (!checklistListResultSchema.safeParse(envelope.data).success) {
    return failure('checklist list', 'Daemon returned an invalid checklist.', envelope.data);
  }
  return envelope;
}

export async function runChecklistSetCommand(
  input: { cwd: string; items: readonly string[] },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('checklist.set', { cwd: input.cwd, items: input.items }, client)), command: 'checklist set' };
  if (!envelope.ok) return envelope;
  if (!checklistSetResultSchema.safeParse(envelope.data).success) {
    return failure('checklist set', 'Daemon returned an invalid checklist.', envelope.data);
  }
  return envelope;
}

export async function runChecklistClearCommand(input: { cwd: string }, client?: RuntimeDaemonClient): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('checklist.clear', { cwd: input.cwd }, client)), command: 'checklist clear' };
  if (!envelope.ok) return envelope;
  if (!checklistClearResultSchema.safeParse(envelope.data).success) {
    return failure('checklist clear', 'Daemon returned an invalid checklist clear result.', envelope.data);
  }
  return envelope;
}

function failure(command: string, message: string, data: unknown = null): JsonEnvelope<unknown> {
  return {
    schemaVersion: 1, ok: false, command, data, warnings: [],
    errors: [{ code: 'WTM_DAEMON_REQUEST_FAILED', message, severity: 'error' }],
  };
}
