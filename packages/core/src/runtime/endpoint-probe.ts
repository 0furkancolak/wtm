import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import type { EndpointCandidate } from '../state/store';

/**
 * Asks the operating system whether a port is free, by taking it and letting it go. Nothing
 * short of binding answers the question: the registry only knows about WTM's own leases, and
 * the process squatting on port 3000 is usually not one of them.
 *
 * This runs in a child process. Binding is asynchronous and endpoint allocation is not — it
 * happens inside a database transaction — so the answer has to arrive from somewhere that can
 * be waited on synchronously.
 */
export async function probeEndpoint(candidate: EndpointCandidate): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    if (candidate.protocol === 'tcp') {
      const server = createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host: candidate.host, port: candidate.port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
      return;
    }
    const socket = createSocket(candidate.host.includes(':') ? 'udp6' : 'udp4');
    socket.unref();
    socket.once('error', () => resolve(false));
    socket.bind({ address: candidate.host, port: candidate.port, exclusive: true }, () => {
      socket.close(() => resolve(true));
    });
  });
}

/** The child-process entry: `0` when the endpoint is free, `1` when it is not. */
export async function runEndpointProbe(rawCandidate: string): Promise<number> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(rawCandidate);
  } catch {
    return 2;
  }
  if (!isCandidate(candidate)) return 2;
  return await probeEndpoint(candidate) ? 0 : 1;
}

function isCandidate(value: unknown): value is EndpointCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.protocol === 'tcp' || candidate.protocol === 'udp')
    && typeof candidate.host === 'string'
    && candidate.host.length > 0
    && typeof candidate.port === 'number'
    && Number.isInteger(candidate.port)
    && candidate.port >= 1
    && candidate.port <= 65_535;
}
