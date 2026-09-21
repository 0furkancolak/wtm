import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { isWtmProxyHostname } from '@wtm/core';
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
}

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
  readonly #servers: Server[] = [];
  #started = false;

  constructor(options: ProxyServerOptions) {
    this.#resolveRoute = options.resolveRoute;
    this.#port = options.port;
    this.#hosts = options.hosts ?? defaultProxyHosts;
    this.#onError = options.onError ?? (() => {});
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
    this.#proxyRequest(request, response, outcome.route);
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
