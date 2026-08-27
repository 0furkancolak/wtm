import type { JsonEnvelope } from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export function runStopCommand(
  input: { cwd: string; taskName?: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeCommand('stop', input, client);
}
