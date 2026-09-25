import { jsonEnvelopeSchema, maxReadinessTimeoutMs, readinessLaunchAllowanceMs, type JsonEnvelope, type RuntimeStartArguments } from '@wtm/protocol';
import { DaemonConnectionLostError, DaemonRequestTimeoutError } from '../client';

/**
 * How long `start`, `restart` and `stop` wait for the daemon's answer. The client's 5s default is
 * right for a read, and shorter than what these legitimately take: a `stop` waits out the task's
 * `grace_period` before escalating, and a `start` can queue behind the previous run's exit being
 * recorded and then spend up to 10s on each launch handshake step. A timeout there used to read
 * as "the daemon is unavailable" while the daemon went on and did it.
 */
export const lifecycleRequestTimeoutMs = 60_000;

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
  } catch (error) {
    if (error instanceof DaemonRequestTimeoutError) return timedOut(command, error.timeoutMs);
    if (error instanceof DaemonConnectionLostError) return connectionLost(command);
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
  } : { timeoutMs: lifecycleRequestTimeoutMs };
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

/**
 * Connected, sent, and no answer in time. Kept apart from {@link unavailable}: the daemon is up
 * and may still carry the request out, so "start it" is the wrong advice and "retry" can double
 * an action.
 */
function timedOut(command: string, timeoutMs: number): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_DAEMON_TIMEOUT',
      message: `The WTM daemon accepted the request but did not answer within ${Math.round(timeoutMs / 1000)}s. `
        + 'It may still complete it; check `wtm ps` before retrying.',
      severity: 'error',
      context: { command, timeoutMs },
    }],
  };
}

function connectionLost(command: string): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    data: null,
    warnings: [],
    errors: [{
      code: 'WTM_DAEMON_UNAVAILABLE',
      message: 'The WTM daemon closed the connection before answering. The request may or may not have taken '
        + 'effect; check `wtm ps` before retrying.',
      severity: 'error',
      context: { command, reason: 'connection-lost' },
    }],
  };
}
