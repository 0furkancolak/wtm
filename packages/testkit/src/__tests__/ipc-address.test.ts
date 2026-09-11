import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fixtureIpcAddress, ipcEndpointAbsent } from '../ipc-address';
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
  const server = createServer((socket) => { socket.on('error', () => {}); socket.end('fixture reply'); });
  try {
    expect(await ipcEndpointAbsent(address)).toBe(true);
    await listen();
    expect(await ipcEndpointAbsent(address)).toBe(false);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(address);
      let output = '';
      socket.on('data', (chunk) => { output += chunk.toString(); });
      socket.once('end', () => resolve(output));
      socket.once('error', reject);
    });
    expect(reply).toBe('fixture reply');
    await close();
    expect(await ipcEndpointAbsent(address)).toBe(true);
    await listen();
    expect(await ipcEndpointAbsent(address)).toBe(false);
  } finally {
    if (server.listening) await close();
    await rm(root, { recursive: true, force: true });
  }
  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(address);
    });
  }
  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
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
