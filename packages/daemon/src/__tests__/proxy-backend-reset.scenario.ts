import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ProxyServer } from '../proxy';
import type { ProxyRoute } from '../proxy-routes';

// This reproduces under real Node but not under `bun test`'s own HTTP implementation — a backend
// response prematurely closed after headers emits `'error'` on the client-facing IncomingMessage
// only when Node's http client has an `'error'` listener attached, which is exactly the gap the
// fix closes. Run as a real Node child (like the other `*.scenario.ts` files here) so this
// actually exercises the Node semantics `packages/daemon` runs under in production.

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      resolve(address.port);
    });
  });
}

const backend = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.write('{"partial":true');
  // A dev server crashing or restarting mid-response: the connection resets before `end()`.
  queueMicrotask(() => response.socket?.destroy());
});
const backendPort = await listen(backend);

const routes = new Map<string, ProxyRoute>([
  ['web.auth.wtm.localhost', {
    hostname: 'web.auth.wtm.localhost',
    host: '127.0.0.1',
    port: backendPort,
    worktreeId: 'worktree-1',
    service: 'web',
  }],
]);
const proxy = new ProxyServer({ port: 0, hosts: ['127.0.0.1'], resolveRoute: (hostname) => routes.get(hostname) ?? null });
await proxy.start();
const proxyPort = proxy.addresses()[0]?.port ?? 0;

const settled = new Promise<'settled'>((resolve) => {
  const clientRequest = httpRequest({
    host: '127.0.0.1',
    port: proxyPort,
    path: '/',
    headers: { host: 'web.auth.wtm.localhost' },
  }, (response) => {
    response.resume();
    response.on('close', () => resolve('settled'));
  });
  clientRequest.on('error', () => resolve('settled'));
  clientRequest.end();
});

// A bounded race, not a bare `await`: without the fix this never settles, and the point of this
// scenario is to report that plainly rather than rely on `runScenario`'s own (generous) kill bound.
const outcome = await Promise.race([settled, delay(5000).then(() => 'timed-out' as const)]);

await proxy.close();
await new Promise<void>((resolve) => { backend.close(() => resolve()); });

console.log(JSON.stringify({ outcome }));
process.exit(outcome === 'settled' ? 0 : 1);
