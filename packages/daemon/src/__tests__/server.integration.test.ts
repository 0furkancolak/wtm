import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FrameDecoder,
  encodeFrame,
  ipcResponseSchema,
  protocolVersion,
  type IpcResponse,
  type IpcRequest,
  type JsonEnvelope,
} from '@wtm/protocol';
import { runScenario } from '../../../testkit/src/scenario-child';

const serverModule = await import('../server').catch(() => null);
const clientModule = await import('../../../cli/src/client').catch(() => null);
const cleanups: Array<() => Promise<void>> = [];
const childScript = fileURLToPath(new URL('./server.child.ts', import.meta.url));
const closeScenarioScript = fileURLToPath(new URL('./server-close.scenario.ts', import.meta.url));

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-ipc-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'wtmd.sock');
}

function expectedPrivateSocketPath(path: string): string {
  const leaf = basename(path);
  return join(dirname(path), `${leaf.startsWith('.') ? '_' : '.'}${leaf.slice(1)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await bounded(exited.then(() => undefined), 'child exit');
}

async function spawnSocketChild(mode: 'native' | 'wtm', path: string): Promise<ChildProcess> {
  const child = spawn('node', ['--import', 'tsx', childScript, mode, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => stopChild(child));
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  await bounded(new Promise<void>((resolve, reject) => {
    const inspect = () => {
      if (stdout.includes('ready\n')) resolve();
    };
    child.stdout?.on('data', inspect);
    child.once('exit', (code, signal) => {
      reject(new Error(`socket child exited before ready (${code ?? signal}): ${stderr}`));
    });
    inspect();
  }), 'socket child ready');
  return child;
}

function runNodeCloseScenario(
  scenario:
    | 'regular-replacement'
    | 'live-replacement'
    | 'shield-quarantine-failure'
    | 'shield-hook-failure'
    | 'shield-placeholder-failure',
  path: string,
  privatePath: string,
): Record<string, unknown> {
  const result = runScenario('node', ['--import', 'tsx', closeScenarioScript, scenario, path, privatePath], {
    timeoutMs: 10_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    data,
    warnings: [],
    errors: [],
  };
}

function request(id: string, command: string): Buffer {
  const value: IpcRequest = { protocol: protocolVersion, id, command };
  return encodeFrame(Buffer.from(JSON.stringify(value)));
}

async function connectRaw(path: string): Promise<Socket> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.closed || socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket close timed out')), 5_000);
    timer.unref();
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await lstat(path)).isSocket()) return;
    } catch {
      // Binding is still in progress.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('socket path did not appear');
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function exchangeRaw(path: string, payload: string): Promise<IpcResponse> {
  return await new Promise<IpcResponse>((resolve, reject) => {
    const socket = createConnection(path);
    const decoder = new FrameDecoder();
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      try {
        const [frame] = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        if (frame === undefined) return;
        resolve(ipcResponseSchema.parse(JSON.parse(frame.toString('utf8'))));
        socket.destroy();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('connect', () => socket.write(encodeFrame(Buffer.from(payload))));
  });
}

describe('Unix IPC server and client', () => {
  test('publishes only the public entry and recovers it after an abrupt daemon exit', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    const directory = dirname(path);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, 'first'),
    });
    cleanups.push(() => server.close());
    await server.start();
    expect(Buffer.byteLength(privatePath)).toBeLessThanOrEqual(Buffer.byteLength(path));
    expect((await readdir(directory)).sort()).toEqual([basename(path)]);

    const firstClient = new clientModule.DaemonClient({ socketPath: path });
    cleanups.push(() => firstClient.close());
    await firstClient.start();
    await expect(firstClient.request('ping')).resolves.toEqual(success('ping', 'first'));
    await firstClient.close();
    await Promise.all([server.close(), server.close()]);

    const child = await spawnSocketChild('wtm', path);
    expect((await readdir(directory)).sort()).toEqual([basename(path)]);
    await stopChild(child);
    expect((await readdir(directory)).sort()).toEqual([basename(path)]);
    await expect(lstat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const recovered = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, 'recovered'),
    });
    cleanups.push(() => recovered.close());
    await recovered.start();
    expect((await readdir(directory)).sort()).toEqual([basename(path)]);
    const recoveredClient = new clientModule.DaemonClient({ socketPath: path });
    cleanups.push(() => recoveredClient.close());
    await recoveredClient.start();
    await expect(recoveredClient.request('ping')).resolves.toEqual(success('ping', 'recovered'));
  });

  test('restores a regular replacement at the private bind path after graceful close', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    const replacement = Buffer.from([0, 255, 1, 254, 2, 253]);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());
    await server.start();
    await writeFile(privatePath, replacement);

    await server.close();

    expect(Buffer.from(await Bun.file(privatePath).arrayBuffer())).toEqual(replacement);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('restores a live replacement socket at the private bind path after graceful close', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());
    await server.start();

    const replacement = createServer((socket) => socket.end('replacement-alive'));
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(privatePath, resolve);
    });
    cleanups.push(async () => {
      if (!replacement.listening) return;
      await new Promise<void>((resolve) => replacement.close(() => resolve()));
    });

    await server.close();

    expect((await lstat(privatePath)).isSocket()).toBeTrue();
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(privatePath);
      let body = '';
      socket.once('error', reject);
      socket.on('data', (chunk) => { body += chunk.toString(); });
      socket.once('end', () => resolve(body));
    });
    expect(response).toBe('replacement-alive');
  });

  test('preserves regular and live private-path replacements when the listener runs under Node 24', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-ipc-node-close-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const regularPath = join(directory, 'regular.sock');
    const livePath = join(directory, 'live.sock');

    expect(runNodeCloseScenario(
      'regular-replacement',
      regularPath,
      expectedPrivateSocketPath(regularPath),
    )).toEqual({
      payload: Buffer.from([0, 255, 1, 254, 2, 253]).toString('base64'),
      privateIsFile: true,
    });
    expect(runNodeCloseScenario(
      'live-replacement',
      livePath,
      expectedPrivateSocketPath(livePath),
    )).toEqual({
      privateIsSocket: true,
      response: 'replacement-alive',
    });
  });

  test('closes the listening handle and permits restart after every close-shield preparation failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-ipc-node-shield-failure-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    for (const { scenario, leaf, error } of [
      {
        scenario: 'shield-quarantine-failure' as const,
        leaf: 'q.sock',
        error: 'parent changed while applying private socket close shield',
      },
      { scenario: 'shield-hook-failure' as const, leaf: 'h.sock', error: 'shield stage failed' },
      {
        scenario: 'shield-placeholder-failure' as const,
        leaf: 'p.sock',
        error: 'parent changed while installing private socket close shield',
      },
    ]) {
      const path = join(directory, leaf);
      const result = runNodeCloseScenario(scenario, path, expectedPrivateSocketPath(path));
      expect(result).toMatchObject({ probeResult: 'ECONNREFUSED', restarted: true });
      expect(String(result.closeError)).toContain(error);
    }
  });

  test('retains a raced private-path occupant and reports close cleanup failure', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    let injectRace = false;
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      afterPrivateSocketQuarantine: async () => {
        if (injectRace) await writeFile(privatePath, 'raced replacement');
      },
      handler: async (value) => success(value.command, null),
    });
    await server.start();
    await writeFile(privatePath, 'original replacement');
    injectRace = true;

    await expect(server.close()).rejects.toThrow('private socket close shield');

    expect(await Bun.file(privatePath).text()).toBe('original replacement');
    const contents = await Promise.all((await readdir(dirname(path)))
      .filter((leaf) => leaf !== basename(privatePath))
      .map(async (leaf) => await Bun.file(join(dirname(path), leaf)).text()));
    expect(contents).toContain('raced replacement');
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(server.close()).resolves.toBeUndefined();
  });

  test('supports one-character and dot-prefixed public socket basenames within the public path budget', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const directory = await mkdtemp(join(tmpdir(), 'wtm-ipc-leaf-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));

    for (const { publicLeaf, privateLeaf } of [
      { publicLeaf: 'x', privateLeaf: '_' },
      { publicLeaf: '_', privateLeaf: '-' },
      { publicLeaf: '.x', privateLeaf: '_x' },
      { publicLeaf: 'x.', privateLeaf: '_.' },
    ]) {
      const path = join(directory, publicLeaf);
      const privatePath = join(directory, privateLeaf);
      const server = new serverModule.UnixIpcServer({
        socketPath: path,
        handler: async (value) => success(value.command, publicLeaf),
      });
      const client = new clientModule.DaemonClient({ socketPath: path });
      await server.start();
      await client.start();
      await expect(client.request('ping')).resolves.toEqual(success('ping', publicLeaf));
      expect(Buffer.byteLength(privatePath)).toBeLessThanOrEqual(Buffer.byteLength(path));
      await client.close();
      await server.close();
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('recovers a stale deterministic private bind entry before publication', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    const child = await spawnSocketChild('native', privatePath);
    await stopChild(child);
    expect((await lstat(privatePath)).isSocket()).toBeTrue();

    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, 'recovered-private'),
    });
    cleanups.push(() => server.close());
    await server.start();
    expect((await readdir(dirname(path))).sort()).toEqual([basename(path)]);
    const client = new clientModule.DaemonClient({ socketPath: path });
    cleanups.push(() => client.close());
    await client.start();
    await expect(client.request('ping')).resolves.toEqual(success('ping', 'recovered-private'));
  });

  test('fails closed without displacing a live deterministic private bind socket', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    const child = await spawnSocketChild('native', privatePath);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toThrow('already in use');
    expect((await lstat(privatePath)).isSocket()).toBeTrue();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await stopChild(child);
  });

  test('preserves a non-socket deterministic private bind path and fails startup', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const privatePath = expectedPrivateSocketPath(path);
    await writeFile(privatePath, 'private path occupant');
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toThrow('not a Unix socket');
    expect(await Bun.file(privatePath).text()).toBe('private path occupant');
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('allows exactly one concurrent daemon to publish without displacing it', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const first = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, 'first'),
    });
    const second = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (value) => success(value.command, 'second'),
    });
    cleanups.push(async () => { await second.close(); await first.close(); });

    const starts = await Promise.allSettled([first.start(), second.start()]);
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await readdir(dirname(path))).sort()).toEqual([basename(path)]);

    const client = new clientModule.DaemonClient({ socketPath: path });
    cleanups.push(() => client.close());
    await client.start();
    const winner = (await client.request('ping')).data;
    expect(typeof winner).toBe('string');
    expect(['first', 'second']).toContain(winner as string);
  });

  test('correlates a real socket request and creates a user-only socket', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    await chmod(dirname(path), 0o777);
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (request) => success(request.command, { arguments: request.arguments }),
    });
    const client = new clientModule.DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(async () => { await client.close(); await server.close(); });

    await server.start();
    await client.start();
    const response = await client.request('echo', { value: 42 });

    expect(response).toEqual(success('echo', { arguments: { value: 42 } }));
    expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test('returns sanitized stable failures for malformed and incompatible requests', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (request) => success(request.command, null),
    });
    cleanups.push(() => server.close());
    await server.start();

    const malformed = await exchangeRaw(path, '{not-json');
    const incompatible = await exchangeRaw(path, JSON.stringify({
      protocol: { major: 2, minor: 0 },
      id: 'version-check',
      command: 'status',
    }));
    const invalidSchema = await exchangeRaw(path, JSON.stringify({
      protocol: protocolVersion,
      id: 'schema-check',
      command: '',
    }));

    expect(malformed.id).toBe('invalid-request');
    expect(malformed.envelope.errors[0]?.code).toBe('WTM_DAEMON_INVALID_REQUEST');
    expect(JSON.stringify(malformed)).not.toContain('SyntaxError');
    expect(incompatible.id).toBe('version-check');
    expect(incompatible.protocol).toEqual(protocolVersion);
    expect(incompatible.envelope.errors[0]?.code).toBe('WTM_DAEMON_PROTOCOL_INCOMPATIBLE');
    expect(invalidSchema.id).toBe('schema-check');
    expect(invalidSchema.envelope.errors[0]?.code).toBe('WTM_DAEMON_INVALID_REQUEST');
  });

  test('never unlinks a live socket owned by another server instance', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const first = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (request) => success(request.command, 'first-live-server'),
    });
    const second = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async (request) => success(request.command, 'second-server'),
    });
    const client = new clientModule.DaemonClient({ socketPath: path });
    cleanups.push(async () => { await client.close(); await second.close(); await first.close(); });
    await first.start();

    await expect(second.start()).rejects.toThrow('already in use');
    await client.start();
    expect(await client.request('ping')).toEqual(success('ping', 'first-live-server'));
  });

  test('does not replace a non-socket path and rejects pending requests on close', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const occupiedPath = await socketPath();
    await writeFile(occupiedPath, 'owned by another process', { mode: 0o644 });
    const blocked = new serverModule.UnixIpcServer({
      socketPath: occupiedPath,
      handler: async () => success('blocked', null),
    });
    await expect(blocked.start()).rejects.toThrow('not a Unix socket');
    expect(await Bun.file(occupiedPath).text()).toBe('owned by another process');

    const path = await socketPath();
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      handler: async () => {
        markReceived();
        await handlerReleased;
        return success('wait', null);
      },
    });
    const client = new clientModule.DaemonClient({ socketPath: path, requestTimeoutMs: 10_000 });
    cleanups.push(async () => { await client.close(); await server.close(); });
    await server.start();
    await client.start();
    const pending = client.request('wait');
    await received;
    const rejected = pending.catch((error: unknown) => error);
    await client.close();
    releaseHandler();

    await expect(rejected).resolves.toMatchObject({ message: expect.stringContaining('closed') });
    await server.close();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('closes a connection that leaves a partial frame idle and keeps serving', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      partialFrameIdleTimeoutMs: 50,
      handler: async (value) => success(value.command, 'alive'),
    });
    cleanups.push(() => server.close());
    await server.start();

    const abusive = await connectRaw(path);
    abusive.write(Buffer.from([0, 0]));
    await waitForClose(abusive);

    const client = new clientModule.DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    await expect(client.request('ping')).resolves.toEqual(success('ping', 'alive'));
  });

  test('enforces per-connection in-flight request limits without crashing the server', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      maxInFlightPerConnection: 1,
      handler: async (value) => {
        calls += 1;
        if (value.command === 'blocked') await released;
        return success(value.command, 'alive');
      },
    });
    cleanups.push(async () => { release(); await server.close(); });
    await server.start();

    const abusive = await connectRaw(path);
    abusive.write(Buffer.concat([request('one', 'blocked'), request('two', 'overflow')]));
    await waitForClose(abusive);
    expect(calls).toBe(1);
    release();

    const client = new clientModule.DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    await expect(client.request('ping')).resolves.toEqual(success('ping', 'alive'));
  });

  test('enforces the total connection limit without displacing an established client', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      maxConnections: 1,
      handler: async (value) => success(value.command, 'first'),
    });
    cleanups.push(() => server.close());
    await server.start();

    const first = await connectRaw(path);
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const decoder = new FrameDecoder();
      first.once('error', reject);
      first.on('data', (chunk) => {
        const [frame] = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        if (frame !== undefined) resolve(ipcResponseSchema.parse(JSON.parse(frame.toString('utf8'))));
      });
    });
    first.write(request('established', 'ping'));
    await expect(bounded(response, 'established response')).resolves.toMatchObject({
      id: 'established',
      envelope: { ok: true },
    });
    const rejected = await connectRaw(path);
    await waitForClose(rejected);
    first.destroy();
  });

  test('caps queued output for a non-reading client and keeps serving small responses', async () => {
    expect(serverModule).not.toBeNull();
    expect(clientModule).not.toBeNull();
    if (serverModule === null || clientModule === null) return;
    const path = await socketPath();
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      maxPendingOutputBytes: 512,
      handler: async (value) => success(value.command, value.command === 'large' ? 'x'.repeat(2_048) : 'small'),
    });
    cleanups.push(() => server.close());
    await server.start();

    const abusive = await connectRaw(path);
    abusive.pause();
    abusive.write(request('large', 'large'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    abusive.resume();
    await waitForClose(abusive);

    const client = new clientModule.DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    await expect(client.request('ping')).resolves.toEqual(success('ping', 'small'));
  });

  test('does not dispatch application requests before socket chmod completes', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    let releaseChmod!: () => void;
    const chmodReleased = new Promise<void>((resolve) => { releaseChmod = resolve; });
    let calls = 0;
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      beforeSocketChmod: async () => chmodReleased,
      handler: async (value) => { calls += 1; return success(value.command, 'ready'); },
    });
    cleanups.push(async () => { releaseChmod(); await server.close(); });
    const starting = server.start();
    await waitForPath(path);
    const socket = await connectRaw(path);
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const decoder = new FrameDecoder();
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        const [frame] = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        if (frame !== undefined) resolve(ipcResponseSchema.parse(JSON.parse(frame.toString('utf8'))));
      });
    });
    socket.write(request('pre-mode', 'ping'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(0);
    releaseChmod();
    await bounded(starting, 'server start');
    await expect(bounded(response, 'pre-mode response')).resolves.toMatchObject({ id: 'pre-mode' });
    socket.destroy();
  });

  test('fails startup when the published socket inode changes after chmod and preserves the replacement', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const displaced = `${path}.owned`;
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      afterSocketChmod: async () => {
        await rename(path, displaced);
        await writeFile(path, 'post-chmod replacement');
      },
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toThrow('changed after permissions were secured');
    expect(await Bun.file(path).text()).toBe('post-chmod replacement');
  });

  test('fails startup when the secured parent mode changes after chmod', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      afterSocketChmod: async () => { await chmod(dirname(path), 0o777); },
      handler: async (value) => success(value.command, null),
    });
    cleanups.push(() => server.close());

    await expect(server.start()).rejects.toThrow('parent changed after permissions were secured');
  });

  test('quarantines owned cleanup candidates and never unlinks a raced replacement', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const displaced = `${path}.owned`;
    let raceCleanup = false;
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      beforeOwnedSocketQuarantine: async () => {
        if (!raceCleanup) return;
        await rename(path, displaced);
        await writeFile(path, 'cleanup replacement');
      },
      handler: async (value) => success(value.command, null),
    });
    await server.start();
    raceCleanup = true;

    await expect(server.close()).rejects.toThrow('changed while quarantining owned socket');
    expect(await Bun.file(path).text()).toBe('cleanup replacement');
    expect((await readdir(dirname(path))).sort()).toEqual([
      basename(displaced),
      basename(path),
    ].sort());
    await expect(server.close()).resolves.toBeUndefined();
  });

  test('rechecks stale socket identity after atomic quarantine and preserves a raced replacement', async () => {
    expect(serverModule).not.toBeNull();
    if (serverModule === null) return;
    const path = await socketPath();
    const incumbent = createServer();
    await new Promise<void>((resolve, reject) => {
      incumbent.once('error', reject);
      incumbent.listen(path, resolve);
    });
    let incumbentClosed = false;
    cleanups.push(async () => {
      if (incumbentClosed) return;
      await new Promise<void>((resolve) => incumbent.close(() => resolve()));
    });
    const server = new serverModule.UnixIpcServer({
      socketPath: path,
      probeExistingSocket: async () => false,
      beforeStaleSocketQuarantine: async () => {
        await new Promise<void>((resolve) => incumbent.close(() => resolve()));
        incumbentClosed = true;
        await writeFile(path, 'replacement');
      },
      handler: async (value) => success(value.command, null),
    });

    await expect(server.start()).rejects.toThrow('changed while checking stale ownership');
    expect(await Bun.file(path).text()).toBe('replacement');
  });
});
