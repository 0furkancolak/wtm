import { createServer } from 'node:net';
import type { JsonEnvelope } from '@wtm/protocol';
import { UnixIpcServer } from '../server';

const mode = process.argv[2];
const socketPath = process.argv[3];

if ((mode !== 'native' && mode !== 'wtm') || socketPath === undefined) {
  throw new Error('Expected child mode and socket path');
}

if (mode === 'native') {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
} else {
  const server = new UnixIpcServer({
    socketPath,
    handler: async (request): Promise<JsonEnvelope<unknown>> => ({
      schemaVersion: 1,
      ok: true,
      command: request.command,
      data: 'child',
      warnings: [],
      errors: [],
    }),
  });
  await server.start();
}

process.stdout.write('ready\n');
await new Promise<never>(() => {});
