import { jsonEnvelopeSchema, maxReadinessTimeoutMs, readinessLaunchAllowanceMs, type JsonEnvelope, type RuntimeStartArguments } from '@wtm/protocol';

export interface RuntimeRequestOptions { signal?: AbortSignal; timeoutMs?: number; cancelRemote?: boolean }

export interface RuntimeDaemonClient {
  request(command: string, args?: unknown, options?: RuntimeRequestOptions): Promise<JsonEnvelope<unknown>>;
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
  options?: RuntimeRequestOptions,
): Promise<JsonEnvelope<unknown>> {
  if (client === undefined) return unavailable(command);
  try {
    const envelope = options === undefined ? await client.request(command, args) : await client.request(command, args, options);
    return jsonEnvelopeSchema.parse(envelope) as JsonEnvelope<unknown>;
  } catch {
    return unavailable(command);
  }
}

export async function requestRuntimeStart(
  command: 'start' | 'restart',
  input: RuntimeStartArguments,
  client?: RuntimeDaemonClient,
  signal?: AbortSignal,
): Promise<JsonEnvelope<unknown>> {
  const aborted = (): JsonEnvelope<null> => ({
    schemaVersion: 1, ok: false, command, data: null, warnings: [],
    errors: [{ code: 'RUNTIME_READINESS_ABORTED', message: 'Readiness observation was cancelled.', severity: 'error' }],
  });
  if (input.wait === true && signal?.aborted) return aborted();
  // Without an override only the daemon knows the configured observation deadline.
  const options = input.wait === true ? {
    timeoutMs: (input.waitTimeoutMs ?? maxReadinessTimeoutMs) + readinessLaunchAllowanceMs,
    cancelRemote: true,
    ...(signal === undefined ? {} : { signal }),
  } : undefined;
  const result = await requestRuntimeCommand(command, input, client, options);
  return input.wait === true && signal?.aborted && result.errors[0]?.code === 'WTM_DAEMON_UNAVAILABLE' ? aborted() : result;
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
