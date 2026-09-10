import type { JsonEnvelope, RuntimeStartArguments } from '@wtm/protocol';
import { requestRuntimeStart, type RuntimeDaemonClient } from './runtime-client';

export function runRestartCommand(
  input: RuntimeStartArguments,
  client?: RuntimeDaemonClient,
  signal?: AbortSignal,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeStart('restart', input, client, signal);
}
