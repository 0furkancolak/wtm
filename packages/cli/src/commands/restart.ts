import type { JsonEnvelope } from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export function runRestartCommand(
  input: { cwd: string; taskName: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeCommand('restart', input, client);
}
