import { createHash } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join as posixJoin } from 'node:path/posix';
import { resolve as win32Resolve } from 'node:path/win32';

/** A real local transport address, isolated by the fixture directory and endpoint name. */
export function fixtureIpcAddress(
  root: string,
  name = 'wtmd.sock',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return posixJoin(root, name);
  const digest = createHash('sha256').update(JSON.stringify([win32Resolve(root), name])).digest('hex');
  return `\\\\.\\pipe\\wtm-test-${digest}`;
}

interface IpcAbsenceOptions {
  timeoutMs?: number;
  /** Fault injection stays at the socket boundary; ordinary callers use a real connection. */
  connect?: (address: string) => Socket;
}

/** Named pipes have no filesystem entry. Only an explicit connection refusal proves absence. */
export async function ipcEndpointAbsent(address: string, options: IpcAbsenceOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new RangeError('IPC absence timeout must be between 1 and 5000 milliseconds');
  }
  return await new Promise<boolean>((resolve, reject) => {
    const socket = (options.connect ?? createConnection)(address);
    let settled = false;
    const finish = (absent: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(absent);
      else reject(error);
    };
    const timer = setTimeout(() => finish(false, Object.assign(
      new Error('IPC absence probe timed out without evidence of absence'), { code: 'ETIMEDOUT' },
    )), timeoutMs);
    socket.once('connect', () => finish(false));
    // Retain the error listener until the destroyed handle is collected: a late error must not
    // become an unhandled event after connect/timeout already settled this observation.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') finish(true);
      else finish(false, error);
    });
  });
}

/**
 * A fixture endpoint whose close is finite.
 *
 * `Server.close()` alone is not that: Node documents it as keeping existing connections and
 * finishing only "when all connections are ended", so its callback is hostage to every peer that
 * still holds a handle. The daemon's own server destroys the sockets it tracks before it closes
 * for exactly this reason, and it can only do that because it has tracked them since it was
 * created — `net.Server` offers no way to enumerate connections after the fact (`getConnections`
 * counts them). A fixture that calls `createServer` directly therefore has to opt into the same
 * bookkeeping at creation, which is what this does.
 */
export function createTrackedIpcServer(handler: (socket: Socket) => void): TrackedIpcServer {
  const live = new Set<Socket>();
  const server = createServer((socket) => {
    live.add(socket);
    socket.once('close', () => live.delete(socket));
    handler(socket);
  });
  return {
    server,
    listen: (address: string) => new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error); };
      const ready = (): void => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(address);
    }),
    close: async () => {
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error); });
      });
    },
  };
}

export interface TrackedIpcServer {
  readonly server: Server;
  /** Resolves once the endpoint is bound, rejects with the `listen` error otherwise. */
  listen(address: string): Promise<void>;
  /** Destroys every live connection, then closes. Never waits on a peer to let go. */
  close(): Promise<void>;
}

/**
 * Whether something is answering at `address` right now — the platform-neutral replacement for
 * `lstat(socketPath).isSocket()` in a startup wait.
 *
 * That check cannot be written on Windows at all: a named pipe is not a filesystem entry, so the
 * `lstat` a POSIX fixture polls on never succeeds there however healthy the daemon is, and the
 * wait can only end in its own timeout. A connection is the one observation both transports share,
 * and it is also the stronger one — a bound socket file can exist before anything accepts on it.
 *
 * Anything inconclusive, a refusal and an unresponsive endpoint alike, reads as "not yet": a poll
 * wants a boolean per attempt, and the caller's own deadline is what decides the wait.
 */
export async function ipcEndpointReachable(address: string, options: IpcAbsenceOptions = {}): Promise<boolean> {
  try {
    return !(await ipcEndpointAbsent(address, options));
  } catch {
    return false;
  }
}
