import { spawnSync } from 'node:child_process';
import type {
  EndpointAvailabilityProbe,
  EndpointCandidate,
  EndpointLease,
  EndpointRequest,
  StateStore,
} from '../state/store';
import { parseEndpointBatch, validEndpointBatchResults } from './endpoint-batch';

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

// The plain Node helper cannot import TypeScript. Its bind operations match endpoint-probe;
// the parent validates the request and both launch paths are covered by real TCP/UDP tests.
const batchProbeScript = String.raw`
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 131072) process.exit(2); });
process.stdin.on('end', async () => {
  const { candidates } = JSON.parse(raw);
  const available = [];
  for (const candidate of candidates) {
    available.push(await new Promise(resolve => {
      if (candidate.protocol === 'tcp') {
        const server = require('node:net').createServer();
        server.once('error', () => resolve(false));
        server.listen({ host: candidate.host, port: candidate.port, exclusive: true }, () => server.close(() => resolve(true)));
      } else {
        const socket = require('node:dgram').createSocket(candidate.host.includes(':') ? 'udp6' : 'udp4');
        socket.once('error', () => { try { socket.close(() => resolve(false)); } catch { resolve(false); } });
        socket.bind({ address: candidate.host, port: candidate.port, exclusive: true }, () => socket.close(() => resolve(true)));
      }
    }));
  }
  process.stdout.write(JSON.stringify({ available }));
});
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

let installedProbe: EndpointAvailabilityProbe | null = null;

/**
 * Replaces how WTM asks whether a port is free.
 *
 * The default spawns `node -e` with the script above, which is correct wherever the running
 * executable is a Node. The standalone build's executable is WTM itself, which has no `-e`:
 * left alone it fails every probe, and a workspace with ports configured is told its whole
 * range is taken. That build installs a probe that re-invokes itself instead.
 */
export function installEndpointProbe(probe: EndpointAvailabilityProbe): void {
  installedProbe = probe;
  // Legacy hooks must keep their original one-argument, first-free short-circuit behavior.
  if (probe.batch === undefined) delete isEndpointAvailable.batch;
  else isEndpointAvailable.batch = (candidates) => probe.batch!(candidates);
}

const defaultProbe = spawnedEndpointProbe(process.execPath, ['-e', probeScript], ['-e', batchProbeScript]);

export const isEndpointAvailable: EndpointAvailabilityProbe = Object.assign((candidate: EndpointCandidate): boolean => {
  if (installedProbe !== null) return installedProbe(candidate);
  return defaultProbe(candidate);
}, { batch: (candidates: readonly EndpointCandidate[]): readonly boolean[] => {
  return defaultProbe.batch!(candidates);
} });

/** Runs `executable` as the probe child, the way the default runs `node -e`. */
export function spawnedEndpointProbe(
  executable: string,
  prefixArgs: readonly string[],
  batchPrefixArgs?: readonly string[],
): EndpointAvailabilityProbe {
  const probe: EndpointAvailabilityProbe = (candidate) => {
    const result = spawnSync(executable, [...prefixArgs, JSON.stringify(candidate)], {
      stdio: 'ignore',
      timeout: 2_000,
      // A SIGTERM-resistant helper must not outlive its synchronous deadline.
      killSignal: 'SIGKILL',
    });
    return result.status === 0 && result.signal === null && result.error === undefined;
  };
  if (batchPrefixArgs !== undefined) probe.batch = (candidates) => {
    const unavailable = () => candidates.map(() => false);
    const raw = JSON.stringify({ candidates });
    if (parseEndpointBatch(raw) === null) return unavailable();
    const result = spawnSync(executable, [...batchPrefixArgs], {
      input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 4096,
    });
    if (result.status !== 0 || result.signal !== null || result.error !== undefined) return unavailable();
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return unavailable();
      const object = value as Record<string, unknown>;
      return Object.keys(object).length === 1 && validEndpointBatchResults(object.available, candidates.length)
        ? object.available : unavailable();
    } catch { return unavailable(); }
  };
  return probe;
}

export function allocateStableEndpoint(
  store: StateStore,
  input: EndpointRequest,
  probe: EndpointAvailabilityProbe = isEndpointAvailable,
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
