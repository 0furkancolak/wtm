import type { JsonEnvelope } from '@wtm/protocol';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

export function runPsCommand(
  input: { cwd: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  return requestRuntimeCommand('ps', input, client);
}
