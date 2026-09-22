import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { isWtmProxyHostname } from '@wtm/core';
import { injectBeforeBodyClose, isHtmlContentType } from './dev-overlay';
import type { ProxyRoute } from './proxy-routes';

/**
 * The local reverse proxy (todo item 12b): a plain HTTP server that routes an incoming request
 * by its `Host` header to the loopback port an endpoint lease already holds, so a developer can
 * reach a running task at `http://<service>.<slug>.wtm.localhost:<proxy-port>` instead of
 * memorizing which dynamic port WTM gave it this session.
 *
 * **What this does not do, honestly**: it does not bind port 80. Doing that needs root/setcap on
 * Linux or admin rights on Windows, which this unit does not attempt (decision 4 in the W9-4
 * plan), so the URL a person actually types still carries `:<proxy-port>`. This delivers a
 * stable, memorable *hostname* in place of a dynamic port number — not the fully port-free URL
 * bar item 12's headline describes. See `docs/07`'s "Local reverse proxy" section.
 */
export const defaultProxyPort = 19_999;

/** Loopback only, on purpose — see decision 3 in the W9-4 plan. Never widen this default. */
export const defaultProxyHosts: readonly string[] = ['127.0.0.1', '::1'];

export interface ProxyServerOptions {
  /** Resolves a validated `<service>.<slug>.wtm.localhost` hostname to its backend, or `null`. */
  resolveRoute(hostname: string): ProxyRoute | null;
  port: number;
  /**
   * The loopback addresses to listen on. Defaults to {@link defaultProxyHosts}. Exists so a test
   * can bind `127.0.0.1` alone on a sandbox without IPv6 — production always takes the default.
   */
  hosts?: readonly string[];
  onError?(error: unknown): void;
  /**
   * The dev overlay's injection hook (todo item 46, W10-4 MVP slice). When set, a backend
   * response whose `content-type` is `text/html` is buffered, has the string this callback
   * returns for the matched `route` spliced in before `</body>` (or appended), and is sent on
   * with `content-length` recomputed. Returning `null` for a given route sends the response on
   * untouched.
   *
   * Left unset (the default, matching `[dev-overlay] enabled = false`), or for any response whose
   * `content-type` is not `text/html`, the response is streamed straight through exactly as
   * before this hook existed — same code path, same byte stream, nothing buffered. See
   * `dev-overlay.ts` for the fragment this builds and `docs/07`'s "Local reverse proxy" section
   * for the prod-non-leak guarantee this is testing against.
   *
   * A response whose `content-encoding` is set to anything other than `identity` is left
   * untouched even when this hook is configured: splicing text into a compressed body would
   * corrupt it, and dev servers overwhelmingly serve HTML uncompressed in practice.
   */
  htmlInjector?(route: ProxyRoute): string | null;

  /**
   * The dev overlay's checklist toggle API (todo item 46b, W11-1): a small JSON API the proxy
   * serves directly, at the reserved path prefix `/__wtm/checklist`, never forwarded to any
   * backend — the browser can only ever reach this loopback proxy, never the daemon's Unix
   * socket, so this is the only way a checked box in the page can reach WTM's state DB. The
   * double-underscore prefix matches how other dev tooling reserves paths (Vite's `/@vite/`,
   * Astro's `/_astro/`); a real backend route that happens to collide with this exact path is a
   * known, out-of-scope-for-this-MVP limitation (see `docs/07`'s "Dev overlay" section).
   *
   * Left unset (the default, matching `[dev-overlay] enabled = false`), a request under
   * `/__wtm/checklist` falls through to the ordinary proxy path completely untouched, exactly as
   * before this hook existed — same gating discipline `htmlInjector` above already established.
   */
  overlayApi?(route: ProxyRoute, request: IncomingMessage): Promise<{ status: number; body: unknown }>;
}

/** The reserved path prefix the checklist toggle API is served under. See `overlayApi` above. */
const overlayApiPathPrefix = '/__wtm/checklist';

/** Why a request was refused before any backend was contacted. */
interface RouteRejection {
  status: number;
  message: string;
}

/**
 * Binds one HTTP listener per configured loopback address and proxies both ordinary requests and
 * `Upgrade` requests (WebSocket, HMR) to whatever `resolveRoute` names for the validated `Host`
 * header. Every other host is refused with a plain 4xx before any backend is contacted — this
 * proxy must never forward a request for a hostname it was not asked to route (decision 7).
 */
export class ProxyServer {
  readonly #resolveRoute: ProxyServerOptions['resolveRoute'];
  readonly #port: number;
  readonly #hosts: readonly string[];
  readonly #onError: (error: unknown) => void;
  readonly #htmlInjector: ProxyServerOptions['htmlInjector'];
  readonly #overlayApi: ProxyServerOptions['overlayApi'];
  readonly #servers: Server[] = [];
  #started = false;

  constructor(options: ProxyServerOptions) {
    this.#resolveRoute = options.resolveRoute;
    this.#port = options.port;
    this.#hosts = options.hosts ?? defaultProxyHosts;
    this.#onError = options.onError ?? (() => {});
    this.#htmlInjector = options.htmlInjector;
    this.#overlayApi = options.overlayApi;
  }

  /**
   * Binds every configured host. A host that fails to bind (most commonly `::1`, on a machine or
   * container with IPv6 disabled) is reported through `onError` and skipped rather than failing
   * the whole proxy — IPv6 is "if you support it" per decision 3, not a requirement. Binding
   * `127.0.0.1` failing (for example, the port is already taken) *does* fail `start()`: that is
   * the address every consumer of this proxy is told to use.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    let boundAny = false;
    let firstFailure: unknown;
    for (const host of this.#hosts) {
      try {
        this.#servers.push(await this.#listen(host));
        boundAny = true;
      } catch (error) {
        firstFailure ??= error;
        this.#onError(error);
      }
    }
    if (!boundAny) {
      this.#started = false;
      throw firstFailure ?? new Error('WTM proxy could not bind any configured host');
    }
  }

  async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const servers = [...this.#servers];
    this.#servers.length = 0;
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
  }

  /** The ports actually bound, one per host that succeeded — always `this.#port` today, but read from the socket rather than assumed. */
  addresses(): Array<{ host: string; port: number }> {
    return this.#servers.map((server) => {
      const address = server.address();
      return typeof address === 'object' && address !== null
        ? { host: address.address, port: address.port }
        : { host: '', port: this.#port };
    });
  }

  #listen(host: string): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.#handleRequest(request, response));
      server.on('upgrade', (request, socket, head) => this.#handleUpgrade(request, socket, head));
      server.once('error', reject);
      server.listen(this.#port, host, () => {
        server.removeListener('error', reject);
        server.on('error', (error) => this.#onError(error));
        resolve(server);
      });
    });
  }

  #route(request: IncomingMessage): { route: ProxyRoute } | { rejection: RouteRejection } {
    const rawHost = request.headers.host;
    if (typeof rawHost !== 'string' || rawHost.trim() === '') {
      return { rejection: { status: 400, message: 'Missing Host header.' } };
    }
    const hostname = hostnameFromHeader(rawHost);
    if (!isWtmProxyHostname(hostname)) {
      return { rejection: {
        status: 400,
        message: `Host must be a *.wtm.localhost name: ${hostname}`,
      } };
    }
    const route = this.#resolveRoute(hostname);
    if (route === null) {
      return { rejection: {
        status: 404,
        message: `No active WTM task is routed to ${hostname}.`,
      } };
    }
    return { route };
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const outcome = this.#route(request);
    if ('rejection' in outcome) {
      response.writeHead(outcome.rejection.status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(outcome.rejection.message);
      return;
    }
    if (this.#overlayApi !== undefined && pathnameOf(request.url).startsWith(overlayApiPathPrefix)) {
      this.#handleOverlayApi(request, response, outcome.route, this.#overlayApi);
      return;
    }
    this.#proxyRequest(request, response, outcome.route);
  }

  /**
   * Serves the dev overlay's checklist toggle API directly — never `#proxyRequest`, so a backend
   * never sees a request under this reserved prefix. `request` is handed to `overlayApi`
   * unconsumed: the hook itself reads whatever body it needs straight off the stream (the request
   * is always small — a `{position, checked}` JSON object at most — so buffering it whole there is
   * the same reasoning `#proxyHtmlResponse`'s own body-buffering comment already gives for
   * response bodies), which keeps this method a plain dispatch with no body-format opinion of its
   * own.
   */
  #handleOverlayApi(
    request: IncomingMessage,
    response: ServerResponse,
    route: ProxyRoute,
    overlayApi: (route: ProxyRoute, request: IncomingMessage) => Promise<{ status: number; body: unknown }>,
  ): void {
    if (!originMatchesHost(request)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Cross-origin requests to the WTM dev-overlay API are refused.');
      return;
    }
    overlayApi(route, request).then((result) => {
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.body));
    }).catch((error: unknown) => {
      this.#onError(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'WTM proxy overlay API failed.' }));
      } else {
        response.destroy();
      }
    });
  }

  #proxyRequest(request: IncomingMessage, response: ServerResponse, route: ProxyRoute): void {
    const outgoing = httpRequest({
      host: route.host,
      port: route.port,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        'x-forwarded-host': request.headers.host ?? '',
        'x-forwarded-proto': 'http',
      },
    }, (backendResponse) => {
      // The dev-overlay hook (todo item 46) only ever looks at an HTML response, and only when
      // configured at all — every other response takes the exact same streaming path this proxy
      // has always taken, untouched: no buffering, no header rewrite, same `pipe`. This is what
      // keeps a disabled overlay, and every non-HTML response even when it is enabled, byte-for-
      // byte identical to a proxy built with no knowledge of the feature.
      if (
        this.#htmlInjector !== undefined
        && isHtmlContentType(backendResponse.headers['content-type'])
        && isUncompressed(backendResponse.headers['content-encoding'])
      ) {
        this.#proxyHtmlResponse(response, backendResponse, route, this.#htmlInjector);
        return;
      }
      response.writeHead(backendResponse.statusCode ?? 502, backendResponse.headers);
      backendResponse.pipe(response);
    });
    outgoing.on('error', (error) => {
      this.#onError(error);
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`WTM proxy could not reach ${route.hostname}: ${errorMessage(error)}`);
      } else {
        response.destroy();
      }
    });
    request.on('error', () => outgoing.destroy());
    request.pipe(outgoing);
  }

  /**
   * The only path that ever buffers a response body whole: an HTML document has to be, since the
   * fragment is spliced into text already sent by the time a stream would otherwise have reached
   * `</body>`. Dev server HTML is small (a handful of KB to a few hundred), so this costs nothing
   * a developer would notice — it is not taken for anything but a `text/html`, uncompressed
   * response, which every other response (JSON, assets, WebSocket upgrades, compressed HTML) never
   * enters.
   */
  #proxyHtmlResponse(
    response: ServerResponse,
    backendResponse: IncomingMessage,
    route: ProxyRoute,
    htmlInjector: (route: ProxyRoute) => string | null,
  ): void {
    const chunks: Buffer[] = [];
    backendResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
    backendResponse.on('error', (error) => {
      this.#onError(error);
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`WTM proxy lost the response from ${route.hostname}: ${errorMessage(error)}`);
      } else {
        response.destroy();
      }
    });
    backendResponse.on('end', () => {
      const fragment = htmlInjector(route);
      const body = Buffer.concat(chunks).toString('utf8');
      const html = fragment === null ? body : injectBeforeBodyClose(body, fragment);
      const headers = { ...backendResponse.headers };
      // The body just changed length; a stale `content-length` would either truncate the overlay
      // or hang the client waiting for bytes that never come. Node recomputes it from `html`.
      delete headers['content-length'];
      response.writeHead(backendResponse.statusCode ?? 502, headers);
      response.end(html);
    });
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const outcome = this.#route(request);
    if ('rejection' in outcome) {
      socket.write(`HTTP/1.1 ${outcome.rejection.status} ${statusText(outcome.rejection.status)}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const route = outcome.route;
    const backend = netConnect(route.port, route.host, () => {
      backend.write(rawRequestHead(request));
      if (head.length > 0) backend.write(head);
      backend.pipe(socket);
      socket.pipe(backend);
    });
    backend.on('error', (error) => { this.#onError(error); socket.destroy(); });
    socket.on('error', () => backend.destroy());
  }
}

/**
 * The overlay API is unauthenticated by design (todo item 46b never added a token) and reachable
 * from any page the developer's browser has open, on a well-known `<service>.<slug>.wtm.localhost`
 * hostname derived deterministically from the branch name — so a third-party page can guess it and
 * fire a same-site-looking `fetch(..., {mode: 'no-cors'})` at it with no preflight. Every browser
 * sends `Origin` on a POST regardless of CORS mode (Fetch §4.7 requires it outside bare same-origin
 * GET/HEAD), so refusing a present-but-mismatched `Origin` closes that CSRF window without needing
 * a token; absent `Origin` (a non-fetch tool, or a top-level GET navigation) is let through, since
 * nothing overlay-API-shaped is reachable that way that a same-origin page couldn't already do.
 */
function originMatchesHost(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** The request path with any `?query` stripped, for matching the reserved overlay API prefix. */
function pathnameOf(url: string | undefined): string {
  if (url === undefined) return '';
  const question = url.indexOf('?');
  return question === -1 ? url : url.slice(0, question);
}

/** Strips a trailing `:<port>` and lowercases, the way every canonical hostname is compared. */
function hostnameFromHeader(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) return trimmed;
  const maybePort = trimmed.slice(colon + 1);
  return /^\d+$/.test(maybePort) ? trimmed.slice(0, colon) : trimmed;
}

/** Rebuilds the request line and headers exactly as received, for splicing onto a raw backend socket. */
function rawRequestHead(request: IncomingMessage): string {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
  const rawHeaders = request.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  lines.push('', '');
  return lines.join('\r\n');
}

function statusText(status: number): string {
  return status === 400 ? 'Bad Request' : status === 404 ? 'Not Found' : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a `content-encoding` header names no compression, so injecting text stays safe. */
function isUncompressed(contentEncoding: string | string[] | undefined): boolean {
  if (contentEncoding === undefined) return true;
  const value = Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding;
  return value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'identity';
}
