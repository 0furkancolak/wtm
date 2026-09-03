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
 */
import type { Server } from 'node:net';
import type { IpcServerPublisher, PublishedIpcServer, PublishOptions } from './types';

export function createWindowsIpcPublisher(): IpcServerPublisher {
  return {
    async publish(server: Server, address: string, _options?: PublishOptions): Promise<PublishedIpcServer> {
      await listen(server, address);
      return {
        address,
        unpublish: () => closeServer(server),
      };
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
