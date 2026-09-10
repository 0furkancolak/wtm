import type { JsonEnvelope, RuntimeStartArguments } from '@wtm/protocol';
import { requestRuntimeStart, type RuntimeDaemonClient } from './runtime-client';

export function runStartCommand(
  input: RuntimeStartArguments,
  client?: RuntimeDaemonClient,
  signal?: AbortSignal,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeStart('start', input, client, signal);
}
