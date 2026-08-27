import { chmod, link, lstat, readFile, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import type { JsonEnvelope } from '@wtm/protocol';
import { UnixIpcServer } from '../server';

const scenario = process.argv[2];
const socketPath = process.argv[3];
const privatePath = process.argv[4];

if (
  (
    scenario !== 'regular-replacement'
    && scenario !== 'live-replacement'
    && scenario !== 'shield-quarantine-failure'
    && scenario !== 'shield-hook-failure'
    && scenario !== 'shield-placeholder-failure'
  )
  || socketPath === undefined
  || privatePath === undefined
) {
  throw new Error('Expected a close scenario and public/private socket paths');
}

const server = new UnixIpcServer({
  socketPath,
  afterPrivateSocketQuarantine: async () => {
    if (scenario === 'shield-hook-failure') throw new Error('shield stage failed');
    if (scenario === 'shield-placeholder-failure') await chmod(dirname(socketPath), 0o777);
  },
  handler: async (request): Promise<JsonEnvelope<unknown>> => ({
    schemaVersion: 1,
    ok: true,
    command: request.command,
    data: null,
    warnings: [],
    errors: [],
  }),
});
await server.start();

if (scenario === 'regular-replacement') {
  const payload = Buffer.from([0, 255, 1, 254, 2, 253]);
  await writeFile(privatePath, payload);
  await server.close();
  process.stdout.write(JSON.stringify({
    payload: (await readFile(privatePath)).toString('base64'),
    privateIsFile: (await lstat(privatePath)).isFile(),
  }));
} else if (scenario === 'live-replacement') {
  const replacement = createServer((socket) => socket.end('replacement-alive'));
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(privatePath, resolve);
  });
  await server.close();
  const privateIsSocket = (await lstat(privatePath)).isSocket();
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(privatePath);
    let body = '';
    socket.once('error', reject);
    socket.on('data', (chunk) => { body += chunk.toString(); });
    socket.once('end', () => resolve(body));
  });
  await new Promise<void>((resolve, reject) => {
    replacement.close((error) => { if (error === undefined) resolve(); else reject(error); });
  });
  process.stdout.write(JSON.stringify({ privateIsSocket, response }));
} else {
  const probePath = `${socketPath}.probe`;
  await link(socketPath, probePath);
  if (scenario === 'shield-quarantine-failure') await chmod(dirname(socketPath), 0o777);
  let closeError = '';
  try {
    await server.close();
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error);
  }
  const probeResult = await new Promise<string>((resolve) => {
    const socket = createConnection(probePath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, 1_000);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? 'error');
    });
  });

  const restarted = new UnixIpcServer({
    socketPath,
    handler: async (request): Promise<JsonEnvelope<unknown>> => ({
      schemaVersion: 1,
      ok: true,
      command: request.command,
      data: null,
      warnings: [],
      errors: [],
    }),
  });
  await restarted.start();
  await restarted.close();
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify({ closeError, probeResult, restarted: true }), () => resolve());
  });
  if (probeResult === 'connected') process.exit(0);
}
