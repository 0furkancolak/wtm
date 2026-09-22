import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ProxyRoute } from '../proxy-routes';
import { ProxyServer } from '../proxy';

/**
 * The dev overlay's checklist toggle API (todo item 46b, W11-1), exercised through a real
 * `ProxyServer` and a real `http.Server` backend — the same harness `proxy-dev-overlay.test.ts`
 * established for `htmlInjector`, applied to `overlayApi`. In particular: `overlayApi` unset (the
 * overlay disabled) must leave a request under `/__wtm/checklist` byte-identical to the ordinary
 * proxy path, the same "disabled means untouched" discipline that file's own test already proves
 * for `htmlInjector`.
 */

function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`backend saw ${request.method} ${request.url}`);
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

function request(options: {
  port: number;
  hostHeader: string;
  method?: string;
  path?: string;
  body?: string;
  origin?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      method: options.method ?? 'GET',
      path: options.path ?? '/',
      headers: {
        host: options.hostHeader,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body === undefined) req.end();
    else req.end(options.body);
  });
}

const hostname = 'web.auth.wtm.localhost';

function routeFor(backendPort: number): Map<string, ProxyRoute> {
  return new Map([[hostname, {
    hostname, host: '127.0.0.1', port: backendPort, worktreeId: 'worktree-1', service: 'web',
  }]]);
}

interface StoredItem { position: number; text: string; checked: boolean }

/** A tiny in-memory checklist, just enough to drive `overlayApi`'s GET/POST contract. */
function fakeChecklist(initial: StoredItem[]) {
  const items = new Map(initial.map((item) => [item.position, { ...item }]));
  return {
    list: () => [...items.values()].sort((a, b) => a.position - b.position),
    setChecked: (position: number, checked: boolean) => {
      const item = items.get(position);
      if (item === undefined) return null;
      item.checked = checked;
      return { ...item };
    },
  };
}

function overlayApiFor(checklist: ReturnType<typeof fakeChecklist>) {
  return async (_route: ProxyRoute, req: import('node:http').IncomingMessage): Promise<{ status: number; body: unknown }> => {
    if ((req.url ?? '').split('?')[0] !== '/__wtm/checklist') return { status: 405, body: { error: 'unrecognized' } };
    if (req.method === 'GET') return { status: 200, body: { items: checklist.list() } };
    if (req.method !== 'POST') return { status: 405, body: { error: 'method' } };
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'bad json' } };
    }
    const { position, checked } = parsed as { position?: unknown; checked?: unknown };
    if (typeof position !== 'number' || typeof checked !== 'boolean') {
      return { status: 400, body: { error: 'bad shape' } };
    }
    const record = checklist.setChecked(position, checked);
    return record === null ? { status: 404, body: { error: 'no such position' } } : { status: 200, body: { item: record } };
  };
}

describe('ProxyServer overlay checklist API', () => {
  let backend: { server: Server; port: number };
  let proxy: ProxyServer;
  let proxyPort: number;

  afterEach(async () => {
    await proxy.close();
    await closeServer(backend.server);
  });

  it('with no overlayApi configured (the default), a request to /__wtm/checklist falls through to the backend untouched', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      // overlayApi intentionally omitted.
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname, path: '/__wtm/checklist' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('backend saw GET /__wtm/checklist');
  });

  it('GET returns the stored list as JSON, never reaching the backend', async () => {
    backend = await startBackend();
    const checklist = fakeChecklist([{ position: 0, text: 'Check it', checked: false }]);
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(checklist),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname, path: '/__wtm/checklist' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [{ position: 0, text: 'Check it', checked: false }] });
  });

  it('POST toggles an item, and a follow-up GET reflects it', async () => {
    backend = await startBackend();
    const checklist = fakeChecklist([{ position: 0, text: 'Check it', checked: false }]);
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(checklist),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const toggle = await request({
      port: proxyPort, hostHeader: hostname, method: 'POST', path: '/__wtm/checklist',
      body: JSON.stringify({ position: 0, checked: true }),
    });
    expect(toggle.status).toBe(200);
    expect(JSON.parse(toggle.body)).toEqual({ item: { position: 0, text: 'Check it', checked: true } });

    const followUp = await request({ port: proxyPort, hostHeader: hostname, path: '/__wtm/checklist' });
    expect(JSON.parse(followUp.body)).toEqual({ items: [{ position: 0, text: 'Check it', checked: true }] });
  });

  it('a malformed POST body is a 400 JSON error, not a crash', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(fakeChecklist([])),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname, method: 'POST', path: '/__wtm/checklist', body: 'not json' });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.any(String) });
  });

  it('toggling a nonexistent position is a 404 JSON error, not a crash', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(fakeChecklist([])),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({
      port: proxyPort, hostHeader: hostname, method: 'POST', path: '/__wtm/checklist',
      body: JSON.stringify({ position: 9, checked: true }),
    });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.any(String) });
  });

  it('a cross-origin POST (CSRF) is refused with 403 and never reaches the checklist store', async () => {
    backend = await startBackend();
    const checklist = fakeChecklist([{ position: 0, text: 'Check it', checked: false }]);
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(checklist),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({
      port: proxyPort, hostHeader: hostname, method: 'POST', path: '/__wtm/checklist',
      body: JSON.stringify({ position: 0, checked: true }),
      origin: 'http://evil.example',
    });
    expect(response.status).toBe(403);

    const followUp = await request({ port: proxyPort, hostHeader: hostname, path: '/__wtm/checklist' });
    expect(JSON.parse(followUp.body)).toEqual({ items: [{ position: 0, text: 'Check it', checked: false }] });
  });

  it('a cross-origin GET is refused with 403 too, not just mutating requests', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(fakeChecklist([{ position: 0, text: 'Check it', checked: false }])),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({
      port: proxyPort, hostHeader: hostname, path: '/__wtm/checklist', origin: 'http://evil.example',
    });
    expect(response.status).toBe(403);
  });

  it('a same-origin POST (Origin matching the request Host) still succeeds', async () => {
    backend = await startBackend();
    const checklist = fakeChecklist([{ position: 0, text: 'Check it', checked: false }]);
    proxy = new ProxyServer({
      port: 0, hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      overlayApi: overlayApiFor(checklist),
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({
      port: proxyPort, hostHeader: hostname, method: 'POST', path: '/__wtm/checklist',
      body: JSON.stringify({ position: 0, checked: true }),
      origin: `http://${hostname}`,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ item: { position: 0, text: 'Check it', checked: true } });
  });
});
