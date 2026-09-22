import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ProxyRoute } from '../proxy-routes';
import { ProxyServer } from '../proxy';

/**
 * The dev overlay's own prod-non-leak test (todo item 46, W10-4) — this is the feature's stated
 * acceptance condition (see `docs/07`'s "Local reverse proxy" section), so it is not optional:
 *
 * - the overlay disabled (the default: no `htmlInjector` configured) must leave a proxied
 *   response byte-identical to `proxy.test.ts`'s own baseline behaviour,
 * - a non-`text/html` response must never be touched, even when the overlay is enabled,
 * - and, by construction, a request that reaches a backend directly — bypassing `ProxyServer`
 *   entirely — can never see the injected fragment at all: there is no code path outside
 *   `ProxyServer`'s own response handling that calls the injector. Nothing here exercises that
 *   directly (there is nothing to exercise: the backend fixture below has no dev-overlay
 *   awareness whatsoever, precisely because injection is proxy-only).
 *
 * Fixture harness copied from `proxy.test.ts` on purpose, to keep both suites exercising the
 * exact same real `http.Server` backend and bare client, per this repo's own convention (see
 * that file and `proxy-routes.test.ts` for the established pattern).
 */

interface HtmlBackendOptions {
  html?: string;
  contentType?: string;
  contentEncoding?: string;
}

function startBackend(options: HtmlBackendOptions = {}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (request.url === '/data.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const headers: Record<string, string> = { 'content-type': options.contentType ?? 'text/html; charset=utf-8' };
      if (options.contentEncoding !== undefined) headers['content-encoding'] = options.contentEncoding;
      response.writeHead(200, headers);
      response.end(options.html ?? '<html><head><title>dev</title></head><body><h1>hi</h1></body></html>');
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
  path?: string;
}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: options.port,
      method: 'GET',
      path: options.path ?? '/',
      headers: { host: options.hostHeader },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const hostname = 'web.auth.wtm.localhost';

function routeFor(backendPort: number): Map<string, ProxyRoute> {
  return new Map([[hostname, {
    hostname, host: '127.0.0.1', port: backendPort, worktreeId: 'worktree-1', service: 'web',
  }]]);
}

describe('ProxyServer dev overlay injection', () => {
  let backend: { server: Server; port: number };
  let proxy: ProxyServer;
  let proxyPort: number;

  afterEach(async () => {
    await proxy.close();
    await closeServer(backend.server);
  });

  it('with no htmlInjector configured (the default, matching [dev-overlay].enabled=false), an HTML response is proxied byte-identical to the baseline', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      // htmlInjector intentionally omitted.
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.status).toBe(200);
    expect(response.body).toBe('<html><head><title>dev</title></head><body><h1>hi</h1></body></html>');
    expect(response.body).not.toContain('wtm-dev-overlay');
  });

  it('injects the fragment before </body> in an HTML response when htmlInjector is configured', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.status).toBe(200);
    expect(response.body).toBe(
      '<html><head><title>dev</title></head><body><h1>hi</h1><div id="wtm-dev-overlay">injected</div></body></html>',
    );
  });

  it('leaves a non-text/html response completely untouched even when htmlInjector is configured', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname, path: '/data.json' });
    expect(response.status).toBe(200);
    expect(response.body).toBe(JSON.stringify({ ok: true }));
    expect(response.body).not.toContain('wtm-dev-overlay');
  });

  it('leaves a plain-text response untouched even when htmlInjector is configured', async () => {
    backend = await startBackend({ html: 'just text, no html here', contentType: 'text/plain; charset=utf-8' });
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.body).toBe('just text, no html here');
  });

  it('leaves a compressed HTML response untouched, since splicing text into it would corrupt it', async () => {
    backend = await startBackend({ html: 'not really gzip, just a stand-in body', contentEncoding: 'gzip' });
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.body).toBe('not really gzip, just a stand-in body');
    expect(response.body).not.toContain('wtm-dev-overlay');
  });

  it('leaves an HTML response declared with a non-UTF-8 charset untouched, since decoding it as UTF-8 would corrupt it', async () => {
    // The byte 0xE9 is "é" in ISO-8859-1; decoded as UTF-8 (an invalid sequence on its own) it
    // becomes U+FFFD, an unrecoverable loss `#proxyHtmlResponse` must never risk for a response
    // that declared a different charset up front. Checked on the raw bytes, not through the
    // shared `request()` helper above: that helper accumulates the response with `body += chunk`,
    // which itself decodes every chunk as UTF-8 — fine for every other test here (all ASCII), but
    // it would corrupt this test's own non-UTF-8 fixture independently of what the proxy does.
    const latin1Body = Buffer.from([0x3c, 0x68, 0x31, 0x3e, 0xe9, 0x3c, 0x2f, 0x68, 0x31, 0x3e]); // <h1>é</h1>
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      response.end(latin1Body);
    });
    backend = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
      });
    });
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const rawBody = await new Promise<Buffer>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/', headers: { host: hostname },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
    expect(rawBody.equals(latin1Body)).toBe(true);
  });

  it('appends the fragment when the HTML response has no </body> tag at all', async () => {
    backend = await startBackend({ html: '<html><body><h1>fragment only' });
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.body).toBe('<html><body><h1>fragment only<div id="wtm-dev-overlay">injected</div>');
  });

  it('proxies the HTML response untouched when htmlInjector returns null for this route (e.g. its worktree just disappeared)', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => null,
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    expect(response.body).toBe('<html><head><title>dev</title></head><body><h1>hi</h1></body></html>');
  });

  it('recomputes content-length after injection rather than sending the backend\'s stale value', async () => {
    backend = await startBackend();
    proxy = new ProxyServer({
      port: 0,
      hosts: ['127.0.0.1'],
      resolveRoute: (name) => routeFor(backend.port).get(name) ?? null,
      htmlInjector: () => '<div id="wtm-dev-overlay">injected</div>',
    });
    await proxy.start();
    proxyPort = proxy.addresses()[0]?.port ?? 0;

    const response = await request({ port: proxyPort, hostHeader: hostname });
    const contentLength = response.headers['content-length'];
    expect(contentLength).toBe(String(Buffer.byteLength(response.body)));
  });
});
