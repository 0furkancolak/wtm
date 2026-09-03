/**
 * Proves `createWindowsIpcPublisher`'s `listen`/`close` orchestration against a fake `net.Server`
 * — nothing here binds a real named pipe. There is no Windows kernel in this repository to bind
 * against (the same position `windows-service.test.ts` and `windows-trust.test.ts` are in for
 * their own OS facts), and D2 is where a real pipe is exercised. What this proves is narrower and
 * fully decidable from here: `publish` calls `listen` with the address and no `readableAll`/
 * `writableAll` override (Node's own default, per `../windows.ts`'s doc comment), resolves once
 * `listening` fires, rejects if `error` fires first, and `unpublish` closes the same server.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import type { Server } from 'node:net';
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
});
