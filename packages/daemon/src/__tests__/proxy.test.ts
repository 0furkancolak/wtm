import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProxyRoute } from '../proxy-routes';
import { ProxyServer } from '../proxy';

/**
 * The backend is a plain `node:http` server standing in for "a task's dev server" — the same
 * pattern the install-script test uses a local `Bun.serve` fixture for. It, and the client
 * requests below, are started directly with in-process function calls, never through
 * `runScenario`: the proxy under test is not a child process in that sense, and neither is this
 * fixture.
 */
function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          body,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

/** A bare client that can set an arbitrary `Host` header, which `fetch` refuses to let a caller override. */
function request(options: {
  port: number;
  hostHeader?: string;
  method?: string;
  path?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: options.hostHeader === undefined ? {} : { host: options.hostHeader },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('ProxyServer', () => {
  let backend: { server: Server; port: number };
  let proxy: ProxyServer;
  let proxyPort: number;
  let routes: Map<string, ProxyRoute>;

  beforeEach(async () => {
    backend = await startBackend();
    routes = new Map([
      ['web.auth.wtm.localhost', {
        hostname: 'web.auth.wtm.localhost',
        host: '127.0.0.1',
        port: backend.port,
        worktreeId: 'worktree-1',
        service: 'web',
      }],
    ]);
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'], // IPv6 is best-effort in production; the sandbox running this test may lack it.
      resolveRoute: (hostname) => routes.get(hostname) ?? null,
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;
  });

  afterEach(async () => {
    await proxy.close();
    await closeServer(backend.server);
  });

  it('proxies a request whose Host header matches an active route to the right backend port', async () => {
    const response = await request({ port: proxyPort, hostHeader: 'web.auth.wtm.localhost', path: '/api/ping' });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { url: string; host: string };
    expect(payload.url).toBe('/api/ping');
    expect(payload.host).toBe('web.auth.wtm.localhost');
  });

  it('forwards the request method and body to the backend', async () => {
    const response = await request({
      port: proxyPort,
      hostHeader: 'web.auth.wtm.localhost',
      method: 'POST',
      path: '/echo',
      body: 'hello from the client',
    });
    const payload = JSON.parse(response.body) as { method: string; body: string };
    expect(payload.method).toBe('POST');
    expect(payload.body).toBe('hello from the client');
  });

  it('rejects a request with no Host header at all', async () => {
    const response = await request({ port: proxyPort });
    expect(response.status).toBe(400);
  });

  it('rejects a forged Host header that does not end in .wtm.localhost — never an open relay', async () => {
    const response = await request({ port: proxyPort, hostHeader: 'example.com' });
    expect(response.status).toBe(400);
    expect(response.body).toContain('wtm.localhost');
  });

  it('rejects a Host header that ends in .wtm.localhost but names no active route', async () => {
    const response = await request({ port: proxyPort, hostHeader: 'api.does-not-exist.wtm.localhost' });
    expect(response.status).toBe(404);
  });

  it('a route removed after the server started stops being reachable on the next request', async () => {
    routes.clear();
    const response = await request({ port: proxyPort, hostHeader: 'web.auth.wtm.localhost' });
    expect(response.status).toBe(404);
  });

  it('reports a backend that refuses the connection as 502, not a hang or a crash', async () => {
    routes.set('web.auth.wtm.localhost', {
      hostname: 'web.auth.wtm.localhost',
      host: '127.0.0.1',
      port: 1, // Reserved; nothing listens there.
      worktreeId: 'worktree-1',
      service: 'web',
    });
    const response = await request({ port: proxyPort, hostHeader: 'web.auth.wtm.localhost' });
    expect(response.status).toBe(502);
  });
});
