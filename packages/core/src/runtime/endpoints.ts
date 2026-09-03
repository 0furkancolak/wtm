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

let installedProbe: ((candidate: EndpointCandidate) => boolean) | null = null;

/**
 * Replaces how WTM asks whether a port is free.
 *
 * The default spawns `node -e` with the script above, which is correct wherever the running
 * executable is a Node. The standalone build's executable is WTM itself, which has no `-e`:
 * left alone it fails every probe, and a workspace with ports configured is told its whole
 * range is taken. That build installs a probe that re-invokes itself instead.
 */
export function installEndpointProbe(probe: (candidate: EndpointCandidate) => boolean): void {
  installedProbe = probe;
}

export function isEndpointAvailable(candidate: EndpointCandidate): boolean {
  if (installedProbe !== null) return installedProbe(candidate);
  const result = spawnSync(process.execPath, ['-e', probeScript, JSON.stringify(candidate)], {
    stdio: 'ignore',
    timeout: 2_000,
    // `spawnSync`'s `timeout` sends `killSignal` — `SIGTERM` by default — once the deadline
    // passes and then keeps waiting for the child; a probe that does not exit on `SIGTERM` (an
    // open handle, a stalled bind) blocks this call forever instead of after 2 seconds. Measured
    // for the identical hazard in `2026-09-03-a-hang-that-cannot-hide.md` (Increment C3), and
    // observed here for real: darwin x64 CI run 33774083849 stalled exactly after this probe's
    // own test, past the job's 30-minute limit, on a commit that touched none of this code.
    // `SIGKILL` is what turns "at most 2 seconds" from a request into a bound.
    killSignal: 'SIGKILL',
  });
  return result.status === 0 && result.signal === null && result.error === undefined;
}

/** Runs `executable` as the probe child, the way the default runs `node -e`. */
export function spawnedEndpointProbe(
  executable: string,
  prefixArgs: readonly string[],
): (candidate: EndpointCandidate) => boolean {
  return (candidate) => {
    const result = spawnSync(executable, [...prefixArgs, JSON.stringify(candidate)], {
      stdio: 'ignore',
      timeout: 2_000,
      // Same reasoning as `isEndpointAvailable`'s identical option, immediately above.
      killSignal: 'SIGKILL',
    });
    return result.status === 0 && result.signal === null && result.error === undefined;
  };
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
