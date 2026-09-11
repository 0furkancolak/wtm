import assert from 'node:assert/strict';
import net, { type Server } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { IpcServerPublisher } from '@wtm/platform';
import { DaemonClient } from '../../../cli/src/client';
import { UnixIpcServer } from '../server';

const mode = process.argv[2];
assert.ok(['deadline', 'cancel', 'disconnect', 'scope'].includes(mode ?? ''));
let port = 0;
const connect = net.createConnection;
// Actual TCP framing isolates request lifetimes from this host's Unix path permissions.
// Production continues to use its normal Unix/named-pipe publisher; native tests retain it.
const publisher: IpcServerPublisher = {
  async publish(server: Server) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    port = address.port;
    return { address: '/wtm-readiness-fixture', unpublish: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); } };
  },
};
net.createConnection = ((...args: Parameters<typeof connect>) => {
  if (args[0] === '/wtm-readiness-fixture') return connect({ port, host: '127.0.0.1' });
  return connect(...args);
}) as typeof connect;
syncBuiltinESMExports();
const observed: AbortSignal[] = [];
let aborted = 0;
let launchCount = 0;
const server = new UnixIpcServer({
  socketPath: '/wtm-readiness-fixture', publisher,
  maxInFlightPerConnection: mode === 'scope' ? 2 : 1,
  handler: async (request, context) => {
    if (request.command === 'start') {
      launchCount += 1;
      assert.ok(context?.signal);
      observed.push(context.signal);
      if (mode === 'deadline') await delay(150);
      else await new Promise<void>((resolve) => {
        if (context.signal.aborted) { aborted += 1; resolve(); return; }
        context.signal.addEventListener('abort', () => { aborted += 1; resolve(); }, { once: true });
      });
    }
    return { schemaVersion: 1, ok: true, command: request.command, data: { observed: true }, warnings: [], errors: [] };
  },
});
const clients: DaemonClient[] = [];
const until = async (predicate: () => boolean) => {
  const deadline = performance.now() + 3000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error('fixture condition deadline'); await delay(5); }
};
try {
  await server.start();
  const makeClient = async () => {
    const client = new DaemonClient({ socketPath: '/wtm-readiness-fixture', requestTimeoutMs: 50 });
    clients.push(client); await client.start(); return client;
  };
  const client = await makeClient();
  if (mode === 'deadline') {
    assert.equal((await client.request('start', {}, { timeoutMs: 1000 })).ok, true);
    assert.equal(observed.length, 1);
  } else {
    const controller = new AbortController();
    const pending = client.request('start', {}, { signal: controller.signal, timeoutMs: 5000, cancelRemote: true }).catch((error) => error);
    await until(() => observed.length === 1);
    if (mode === 'scope') {
      const other = await makeClient();
      const otherPending = other.request('start', {}, { timeoutMs: 5000 }).catch((error) => error);
      await until(() => observed.length === 2);
      controller.abort(); await until(() => aborted === 1);
      assert.equal(observed[0]?.aborted, true);
      assert.equal(observed[1]?.aborted, false);
      assert.equal((await other.request('ping')).ok, true);
      await other.close(); await otherPending; await until(() => aborted === 2);
    } else {
      if (mode === 'cancel') controller.abort();
      else await client.close();
      await until(() => aborted === 1);
      if (mode === 'cancel') assert.equal((await client.request('ping')).ok, true);
    }
    assert.ok((await pending) instanceof Error);
  }
  assert.equal(launchCount, mode === 'scope' ? 2 : 1, 'cancellation must not invoke a new runtime command');
  console.log(JSON.stringify({ mode, verified: true }));
} finally {
  for (const client of clients) await client.close();
  await server.close();
  net.createConnection = connect; syncBuiltinESMExports();
}
