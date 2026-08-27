import type { JsonEnvelope } from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export function runStartCommand(
  input: { cwd: string; taskName: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeCommand('start', input, client);
}
