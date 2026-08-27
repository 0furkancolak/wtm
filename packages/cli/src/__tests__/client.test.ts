import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FrameDecoder,
  encodeFrame,
  ipcRequestSchema,
  protocolVersion,
  type IpcRequest,
  type IpcResponse,
  type JsonEnvelope,
} from '@wtm/protocol';
import { DaemonClient } from '../client';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

function response(request: IpcRequest, data: unknown): Buffer {
  const value: IpcResponse = {
    protocol: protocolVersion,
    id: request.id,
    envelope: success(request.command, data),
  };
  return encodeFrame(Buffer.from(JSON.stringify(value)));
}

async function listenRaw(
  onRequest: (socket: Socket, request: IpcRequest) => void,
): Promise<{ path: string; server: Server }> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-client-'));
  const path = join(directory, 'server.sock');
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
        onRequest(socket, ipcRequestSchema.parse(JSON.parse(frame.toString('utf8'))));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { path, server };
}

describe('DaemonClient', () => {
  test('exports an explicit lifecycle daemon client', () => {
    expect(DaemonClient).toBeFunction();
  });

  test('ignores a timed-out request late response without rejecting an unrelated request', async () => {
    let timedOutRequest: IpcRequest | null = null;
    const { path } = await listenRaw((socket, request) => {
      if (timedOutRequest === null) {
        timedOutRequest = request;
        return;
      }
      socket.write(Buffer.concat([
        response(timedOutRequest, 'late'),
        response(request, 'current'),
      ]));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 50 });
    cleanups.push(() => client.close());
    await client.start();

    await expect(client.request('first')).rejects.toThrow('timed out');
    await expect(client.request('second')).resolves.toEqual(success('second', 'current'));
  });

  test('aborting an in-flight request removes it immediately and tombstones a late response', async () => {
    let abortedRequest: IpcRequest | null = null;
    const { path } = await listenRaw((socket, request) => {
      if (abortedRequest === null) { abortedRequest = request; return; }
      socket.write(Buffer.concat([response(abortedRequest, 'late'), response(request, 'current')]));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 5_000 });
    cleanups.push(() => client.close());
    await client.start();
    const cancellation = new AbortController();
    const requestWithSignal = client.request.bind(client) as (
      command: string, args: unknown, options: { signal: AbortSignal },
    ) => Promise<JsonEnvelope<unknown>>;

    const pending = requestWithSignal('logs', {}, { signal: cancellation.signal });
    cancellation.abort();

    await expect(pending).rejects.toThrow('aborted');
    await expect(client.request('ps')).resolves.toEqual(success('ps', 'current'));
  });

  test('uses a fresh frame decoder after a partial frame corrupts the first connection', async () => {
    let requests = 0;
    const { path } = await listenRaw((socket, request) => {
      requests += 1;
      const encoded = response(request, requests === 1 ? 'partial' : 'reconnected');
      if (requests === 1) {
        socket.end(encoded.subarray(0, 2));
        return;
      }
      socket.write(encoded);
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();

    await expect(client.request('first')).rejects.toThrow('connection closed');
    await client.start();
    await expect(client.request('second')).resolves.toEqual(success('second', 'reconnected'));
    expect(requests).toBe(2);
  });

  test('reconnects immediately with a fresh decoder after an oversized frame header', async () => {
    let requests = 0;
    const { path } = await listenRaw((socket, request) => {
      requests += 1;
      if (requests === 1) {
        const oversized = Buffer.alloc(4);
        oversized.writeUInt32BE(513);
        socket.end(oversized);
        return;
      }
      socket.write(response(request, 'reconnected'));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 1_000, maxFrameBytes: 512 });
    cleanups.push(() => client.close());
    await client.start();

    await expect(client.request('first')).rejects.toThrow('invalid IPC response');
    await client.start();
    await expect(client.request('second')).resolves.toEqual(success('second', 'reconnected'));
    expect(requests).toBe(2);
  });

  test('follows bounded daemon log snapshots as raw incremental chunks until aborted', async () => {
    let requests = 0;
    const { path } = await listenRaw((socket, request) => {
      requests += 1;
      socket.write(response(request, {
        logs: [{ taskName: 'dev', stdout: requests === 1 ? 'one\n' : 'one\ntwo\n', stderr: '' }],
      }));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    const abort = new AbortController();
    let raw = '';

    const exitCode = await client.followLogs({ cwd: '/repo', taskName: 'dev' }, (chunk) => {
      raw += chunk;
      if (raw === 'one\ntwo\n') abort.abort();
    }, { signal: abort.signal, pollIntervalMs: 1 });

    expect(exitCode).toBe(0);
    expect(raw).toBe('one\ntwo\n');
    expect(requests).toBe(2);
  });

  test('follow tracks streams independently across rotation and awaits async output writes', async () => {
    let requests = 0;
    const snapshots = [
      { stdout: 'old-out\n', stderr: 'stable-err\n' },
      { stdout: 'new-out\n', stderr: 'stable-err\n' },
    ];
    const { path } = await listenRaw((socket, request) => {
      const snapshot = snapshots[Math.min(requests, snapshots.length - 1)] as { stdout: string; stderr: string };
      requests += 1;
      socket.write(response(request, { logs: [{ processId: 'process-1', taskName: 'dev', ...snapshot }] }));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    const abort = new AbortController();
    const chunks: string[] = [];

    await client.followLogs({ cwd: '/repo', taskName: 'dev' }, async (chunk) => {
      await Promise.resolve();
      chunks.push(chunk);
      if (chunks.length === 3) abort.abort();
    }, { signal: abort.signal, pollIntervalMs: 1 });

    expect(chunks).toEqual(['old-out\n', 'stable-err\n', 'new-out\n']);
    expect(requests).toBe(2);
  });

  test('follow sends server cursors and emits repeated bytes once across generation rotation', async () => {
    const seenArguments: unknown[] = [];
    let requests = 0;
    const snapshots = [
      { stdout: 'aaaa', cursor: { dev: 1, ino: 2, offset: 4, rotated: false, generation: 'none' } },
      { stdout: 'aa', cursor: { dev: 1, ino: 2, offset: 6, rotated: false, generation: 'none' } },
      { stdout: 'bb', cursor: { dev: 1, ino: 2, offset: 2, rotated: true, generation: '1:99' } },
    ];
    const { path } = await listenRaw((socket, request) => {
      seenArguments.push(request.arguments);
      const snapshot = snapshots[Math.min(requests, snapshots.length - 1)] as {
        stdout: string;
        cursor: { dev: number; ino: number; offset: number; rotated: boolean; generation: string };
      };
      requests += 1;
      socket.write(response(request, {
        logs: [{
          processId: 'process-1',
          taskName: 'dev',
          stdout: snapshot.stdout,
          stderr: '',
          cursors: {
            stdout: snapshot.cursor,
            stderr: { dev: 1, ino: 3, offset: 0, rotated: false },
          },
        }],
      }));
    });
    const client = new DaemonClient({ socketPath: path, requestTimeoutMs: 1_000 });
    cleanups.push(() => client.close());
    await client.start();
    const abort = new AbortController();
    let raw = '';

    await client.followLogs({ cwd: '/repo', taskName: 'dev' }, (chunk) => {
      raw += chunk;
      if (requests === 3) abort.abort();
    }, { signal: abort.signal, pollIntervalMs: 1 });

    expect(raw).toBe('aaaaaabb');
    expect(seenArguments[1]).toMatchObject({
      cursors: { 'process-1': { stdout: { dev: 1, ino: 2, offset: 4, generation: 'none' } } },
    });
    expect(seenArguments[2]).toMatchObject({
      cursors: { 'process-1': { stdout: { dev: 1, ino: 2, offset: 6, generation: 'none' } } },
    });
  });
});
