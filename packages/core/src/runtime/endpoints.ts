import { spawnSync } from 'node:child_process';
import type {
  EndpointCandidate,
  EndpointLease,
  EndpointRequest,
  StateStore,
} from '../state/store';

const probeScript = String.raw`
const candidate = JSON.parse(process.argv[1]);
const finish = (resource, code) => {
  const done = () => process.exit(code);
  try { resource.close(done); } catch { done(); }
};
if (candidate.protocol === 'tcp') {
  const net = require('node:net');
  const server = net.createServer();
  server.unref();
  server.once('error', () => process.exit(1));
  server.listen({ host: candidate.host, port: candidate.port, exclusive: true }, () => finish(server, 0));
} else {
  const dgram = require('node:dgram');
  const socket = dgram.createSocket(candidate.host.includes(':') ? 'udp6' : 'udp4');
  socket.unref();
  socket.once('error', () => process.exit(1));
  socket.bind({ address: candidate.host, port: candidate.port, exclusive: true }, () => finish(socket, 0));
}
`;

export class WtmEndpointAllocationError extends Error {
  readonly code = 'RUNTIME_PORT_UNAVAILABLE' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(input: EndpointRequest, cause?: unknown) {
    super(`No available ${input.protocol} endpoint on ${input.host} in range ${input.portRange.min}-${input.portRange.max}`);
    this.name = 'WtmEndpointAllocationError';
    this.context = {
      worktreeId: input.worktreeId,
      name: input.name,
      protocol: input.protocol,
      host: input.host,
      portRange: input.portRange,
      ...(cause instanceof Error ? { cause: cause.message } : {}),
    };
  }
}

export function isEndpointAvailable(candidate: EndpointCandidate): boolean {
  const result = spawnSync(process.execPath, ['-e', probeScript, JSON.stringify(candidate)], {
    stdio: 'ignore',
    timeout: 2_000,
  });
  return result.status === 0 && result.signal === null && result.error === undefined;
}

export function allocateStableEndpoint(
  store: StateStore,
  input: EndpointRequest,
  probe: (candidate: EndpointCandidate) => boolean = isEndpointAvailable,
): EndpointLease {
  try {
    return store.allocateEndpoint(input, probe);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No available ')) {
      throw new WtmEndpointAllocationError(input, error);
    }
    throw error;
  }
}
