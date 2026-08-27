import { jsonEnvelopeSchema, type JsonEnvelope } from '@wtm/protocol';

export interface RuntimeDaemonClient {
  request(command: string, args?: unknown): Promise<JsonEnvelope<unknown>>;
  followLogs?(
    args: { cwd: string; taskName?: string },
    write: (chunk: string) => void | Promise<void>,
    options?: { signal?: AbortSignal },
  ): Promise<number>;
}

export async function requestRuntimeCommand(
  command: string,
  args: unknown,
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  if (client === undefined) return unavailable(command);
  try {
    const envelope = await client.request(command, args);
    return jsonEnvelopeSchema.parse(envelope) as JsonEnvelope<unknown>;
  } catch {
    return unavailable(command);
  }
}

export function unavailable(command: string): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_DAEMON_UNAVAILABLE',
      message: 'WTM daemon is unavailable.',
      severity: 'error',
      context: { command },
    }],
  };
}
