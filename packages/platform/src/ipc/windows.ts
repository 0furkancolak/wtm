/**
 * The Windows `IpcServerPublisher` (spec `2026-09-03-windows-trust-and-transport-seam.md`, D7).
 *
 * Written, not deferred, because the design question — does the publish protocol need to exist at
 * all on Windows — is answerable from documentation alone: a named pipe is not a filesystem entry
 * once its owning process exits, so there is no stale leftover to quarantine and no half-created
 * state for a client to observe mid-publish, which is the entire reason the POSIX implementation
 * binds to a hidden name and hard-links it into place. So this publisher is `listen()` at the
 * published address directly.
 *
 * `readableAll`/`writableAll` are left at their documented default of `false` rather than passed
 * explicitly, matching Node's own default so a future Node version's own default change is
 * inherited rather than pinned against. Node's docs describe that default as the restrictive one —
 * not accessible to all users — but **that is a documented default, not a measurement**: nothing
 * in this repository binds a real named pipe against a second Windows account. D2 is where that is
 * checked.
 *
 * ## Why `unpublish` destroys connections before it closes
 *
 * `net.Server.close([callback])` is documented as stopping the server from accepting new
 * connections *while keeping the existing ones*, and as finishing "when all connections are ended".
 * The callback therefore never runs while one accepted connection is still open — an unbounded
 * wait, not a slow one. On POSIX that hazard is masked twice over: `UnixIpcServer` destroys every
 * socket it tracks before it unpublishes, and the published name is a filesystem entry that can be
 * unlinked independently of the listener. Neither mask exists here. A named pipe has no entry to
 * unlink, so on Windows `unpublish` *is* the close, and this publisher is a public port: anything
 * that publishes a server whose connections it does not itself track hands this function a wait
 * with no end. `\\.\pipe\...` addresses are also the one transport in this repository a developer
 * cannot exercise locally, so that wait surfaces as a CI leg that runs out of time rather than as
 * a failure anyone can read.
 *
 * So the publisher keeps its own record of what the server it published has accepted, and tears
 * those connections down itself. It is bookkeeping this file can guarantee, unlike the caller's
 * cooperation, and it is a no-op for a caller like `UnixIpcServer` that already destroyed them.
 */
import type { Server, Socket } from 'node:net';
import type { IpcServerPublisher, PublishedIpcServer, PublishOptions } from './types';

export function createWindowsIpcPublisher(): IpcServerPublisher {
  return {
    async publish(server: Server, address: string, _options?: PublishOptions): Promise<PublishedIpcServer> {
      const accepted = trackAcceptedConnections(server);
      try {
        await listen(server, address);
      } catch (error) {
        accepted.releaseAll();
        throw error;
      }
      return {
        address,
        unpublish: async () => {
          accepted.releaseAll();
          await closeServer(server);
        },
      };
    },
  };
}

interface AcceptedConnections {
  /** Stops tracking and destroys whatever is still open. Safe to call more than once. */
  releaseAll(): void;
}

/**
 * Registered as an ordinary second `'connection'` listener, after the callback the caller already
 * passed to `createServer`. That ordering is deliberate: the caller sees every socket first and
 * decides what to do with it, and this listener only records that the socket exists so the close
 * path can be finite.
 */
function trackAcceptedConnections(server: Server): AcceptedConnections {
  const open = new Set<Socket>();
  const onConnection = (socket: Socket): void => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  };
  server.on('connection', onConnection);
  return {
    releaseAll(): void {
      server.off('connection', onConnection);
      for (const socket of open) socket.destroy();
      open.clear();
    },
  };
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path: address });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error); });
  });
}
