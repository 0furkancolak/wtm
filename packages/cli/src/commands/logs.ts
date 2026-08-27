import type { JsonEnvelope } from '@wtm/protocol';
import {
  requestRuntimeCommand,
  unavailable,
  type RuntimeDaemonClient,
} from './runtime-client';

export function runLogsCommand(
  input: { cwd: string; taskName?: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeCommand('logs', { ...input, follow: false }, client);
}

export async function followLogs(
  input: { cwd: string; taskName?: string },
  write: (chunk: string) => void | Promise<void>,
  client?: RuntimeDaemonClient,
  signal?: AbortSignal,
): Promise<{ exitCode: number; failure?: JsonEnvelope<unknown> }> {
  if (client?.followLogs === undefined) return { exitCode: 4, failure: unavailable('logs') };
  try {
    return { exitCode: await client.followLogs(input, write, signal === undefined ? {} : { signal }) };
  } catch {
    return { exitCode: 4, failure: unavailable('logs') };
  }
}
