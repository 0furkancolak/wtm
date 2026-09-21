import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createTrackedIpcServer, fixtureIpcAddress, ipcEndpointAbsent } from '../ipc-address';
import { shortTmpRoot } from '../platform';

test('Windows fixture addresses use a bounded pipe namespace isolated by the complete fixture path', () => {
  const first = fixtureIpcAddress('C:\\fixtures\\first\\same-name', 'daemon.sock', 'win32');
  const second = fixtureIpcAddress('C:\\fixtures\\second\\same-name', 'daemon.sock', 'win32');
  expect(first).toMatch(/^\\\\\.\\pipe\\wtm-test-[a-f0-9]+$/);
  expect(first.length).toBeLessThan(256);
  expect(first).not.toBe(second);
  expect(first).not.toBe(fixtureIpcAddress('C:\\fixtures\\first\\same-name', 'other.sock', 'win32'));
  expect(fixtureIpcAddress(`C:\\${'long-directory\\'.repeat(80)}`, 'daemon.sock', 'win32').length).toBeLessThan(256);
});

test('POSIX fixture addresses retain the explicitly short socket path', () => {
  expect(fixtureIpcAddress('/tmp/wtm-fixture', 'daemon.sock', 'linux')).toBe('/tmp/wtm-fixture/daemon.sock');
  expect(fixtureIpcAddress('/tmp/wtm-fixture', 'daemon.sock', 'darwin')).toBe('/tmp/wtm-fixture/daemon.sock');
});

test('a real fixture endpoint answers, closes, and can be bound again at the same address', async () => {
  const root = await mkdtemp(join(shortTmpRoot(), 'wtm-ipc-'));
  const address = fixtureIpcAddress(root);
  const endpoint = createTrackedIpcServer((socket) => { socket.on('error', () => {}); socket.end('fixture reply'); });
  try {
    expect(await ipcEndpointAbsent(address)).toBe(true);
    await endpoint.listen(address);
    expect(await ipcEndpointAbsent(address)).toBe(false);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(address);
      let output = '';
      socket.on('data', (chunk) => { output += chunk.toString(); });
      socket.once('end', () => { socket.destroy(); resolve(output); });
      socket.once('error', reject);
    });
    expect(reply).toBe('fixture reply');
    await endpoint.close();
    expect(await ipcEndpointAbsent(address)).toBe(true);
    await endpoint.listen(address);
    expect(await ipcEndpointAbsent(address)).toBe(false);
  } finally {
    if (endpoint.server.listening) await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('closing a fixture endpoint does not wait on a peer that never lets go', async () => {
  const root = await mkdtemp(join(shortTmpRoot(), 'wtm-ipc-hold-'));
  const held: Socket[] = [];
  // Neither handler answers and neither client ends: this is the shape `Server.close()` is
  // documented to wait on, and the pair below is the whole argument for tracking connections.
  const bare = createServer((socket) => { socket.on('error', () => {}); });
  const tracked = createTrackedIpcServer((socket) => { socket.on('error', () => {}); });
  try {
    const bareAddress = fixtureIpcAddress(root, 'bare.sock');
    const trackedAddress = fixtureIpcAddress(root, 'tracked.sock');
    await new Promise<void>((resolve, reject) => {
      bare.once('error', reject);
      bare.listen(bareAddress, () => resolve());
    });
    await tracked.listen(trackedAddress);
    await Promise.all([hold(bareAddress), hold(trackedAddress)]);

    let bareCloseSettled = false;
    bare.close(() => { bareCloseSettled = true; });
    await tracked.close();

    // The tracked endpoint has already released its address while the bare one is still waiting.
    expect(await ipcEndpointAbsent(trackedAddress)).toBe(true);
    expect(bareCloseSettled).toBe(false);
  } finally {
    for (const socket of held) socket.destroy();
    if (tracked.server.listening) await tracked.close();
    await rm(root, { recursive: true, force: true });
  }

  async function hold(address: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(address);
      held.push(socket);
      socket.on('error', () => {});
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
  }
});

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`an IPC ${code} failure cannot become evidence of absence`, async () => {
    const socket = new EventEmitter() as Socket;
    let destroyed = false;
    socket.destroy = () => { destroyed = true; return socket; };
    const error = Object.assign(new Error(code), { code });
    await expect(ipcEndpointAbsent('fixture', {
      connect: () => { queueMicrotask(() => socket.emit('error', error)); return socket; },
    })).rejects.toBe(error);
    expect(destroyed).toBe(true);
  });
}

test('an unresponsive IPC probe times out, destroys its handle and never reports absence', async () => {
  const socket = new EventEmitter() as Socket;
  let destroyed = false;
  socket.destroy = () => { destroyed = true; return socket; };
  await expect(ipcEndpointAbsent('fixture', { timeoutMs: 10, connect: () => socket }))
    .rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(destroyed).toBe(true);
});
