/**
 * Proves `createWindowsIpcPublisher`'s `listen`/`close` orchestration against a fake `net.Server`
 * — nothing here binds a real named pipe. There is no Windows kernel in this repository to bind
 * against (the same position `windows-service.test.ts` and `windows-trust.test.ts` are in for
 * their own OS facts), and D2 is where a real pipe is exercised. What this proves is narrower and
 * fully decidable from here: `publish` calls `listen` with the address and no `readableAll`/
 * `writableAll` override (Node's own default, per `../windows.ts`'s doc comment), resolves once
 * `listening` fires, rejects if `error` fires first, and `unpublish` closes the same server.
 *
 * One test below does bind a real endpoint, through `fixtureIpcAddress` — so it is a real named
 * pipe on the win32 leg and a Unix socket everywhere else. It is not a substitute for D2: what it
 * exercises is the *ordering* inside `unpublish`, connections torn down before `Server.close()` is
 * awaited, and that ordering follows from `net.Server`'s documented close semantics, which are the
 * same for either address. Reaching it through a fake server would only assert that the publisher
 * calls methods this file wrote.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fixtureIpcAddress } from '../../../../testkit/src/ipc-address';
import { shortTmpRoot } from '../../../../testkit/src/platform';
import { createWindowsIpcPublisher } from '../windows';

class FakeServer extends EventEmitter {
  listening = false;
  readonly listenCalls: unknown[] = [];
  closeCalls = 0;
  failListen: Error | null = null;
  failClose: Error | null = null;

  listen(options: unknown): this {
    this.listenCalls.push(options);
    queueMicrotask(() => {
      if (this.failListen !== null) {
        this.emit('error', this.failListen);
        return;
      }
      this.listening = true;
      this.emit('listening');
    });
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    queueMicrotask(() => callback?.(this.failClose ?? undefined));
    return this;
  }
}

function fakeServer(): { server: FakeServer; asServer: Server } {
  const server = new FakeServer();
  return { server, asServer: server as unknown as Server };
}

describe('createWindowsIpcPublisher', () => {
  test('listens at the address with no readableAll/writableAll override', async () => {
    const { server, asServer } = fakeServer();
    const publisher = createWindowsIpcPublisher();

    const published = await publisher.publish(asServer, '\\\\.\\pipe\\wtmd');

    expect(server.listenCalls).toEqual([{ path: '\\\\.\\pipe\\wtmd' }]);
    expect(published.address).toBe('\\\\.\\pipe\\wtmd');
  });

  test('rejects when the server errors before it starts listening', async () => {
    const { server, asServer } = fakeServer();
    server.failListen = new Error('EACCES');
    const publisher = createWindowsIpcPublisher();

    await expect(publisher.publish(asServer, '\\\\.\\pipe\\wtmd')).rejects.toThrow('EACCES');
  });

  test('unpublish closes the same server', async () => {
    const { server, asServer } = fakeServer();
    const publisher = createWindowsIpcPublisher();
    const published = await publisher.publish(asServer, '\\\\.\\pipe\\wtmd');

    await published.unpublish();

    expect(server.closeCalls).toBe(1);
  });

  test('unpublish rejects when the server fails to close', async () => {
    const { server, asServer } = fakeServer();
    const publisher = createWindowsIpcPublisher();
    const published = await publisher.publish(asServer, '\\\\.\\pipe\\wtmd');
    server.failClose = new Error('close failed');

    await expect(published.unpublish()).rejects.toThrow('close failed');
  });

  test('unpublish releases the address without waiting on a connection the caller never closed', async () => {
    // The hazard in one sentence: `Server.close()` is documented to keep existing connections and
    // to finish only once they have all ended, so a publisher that only closes is a publisher that
    // can wait forever. `UnixIpcServer` hides this by destroying its own sockets first; this
    // publisher is a port and cannot assume that of every caller.
    const root = await mkdtemp(join(shortTmpRoot(), 'wtm-win-ipc-'));
    const address = fixtureIpcAddress(root);
    const server = createServer((socket) => { socket.on('error', () => { /* held open on purpose. */ }); });
    let client: Socket | null = null;
    try {
      const published = await createWindowsIpcPublisher().publish(server, address);
      expect(published.address).toBe(address);
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(address);
        client = socket;
        socket.on('error', () => { /* the publisher destroys this end. */ });
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });

      await published.unpublish();

      expect(server.listening).toBe(false);
    } finally {
      (client as Socket | null)?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
