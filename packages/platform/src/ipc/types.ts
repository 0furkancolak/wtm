/**
 * The seam is the publish protocol, not the `net` call (spec
 * `2026-09-03-windows-trust-and-transport-seam.md`, D7). Node's `net` module already accepts a
 * Windows named-pipe path and a Unix-domain-socket path as the same kind of `listen()`/`connect()`
 * argument — there is no separate API to abstract there. What differs by platform is everything
 * `packages/daemon/src/server.ts` used to do around that call: a Unix socket is bound to a hidden
 * name, hard-linked onto the published name so a client never observes a half-created socket, and
 * proven trustworthy by `chmod` plus repeated `dev`/`ino`/`uid` identity checks. None of that has a
 * named-pipe analogue — a named pipe is not a filesystem entry once its owner exits, so there is
 * nothing to quarantine and no stale leftover to recover.
 */
import type { Server } from 'node:net';

/**
 * Test seams for the POSIX publish/quarantine dance, moved here unchanged from
 * `UnixIpcServerOptions`. A Windows publisher has no equivalent stage to hook and ignores all of
 * these; they are named for what the POSIX implementation actually does, not generalised into a
 * platform-neutral vocabulary that would fit neither implementation precisely.
 */
export interface PublishOptions {
  /** Overrides how a pre-existing path at the published address is probed before quarantine. */
  probeExistingSocket?: ((path: string) => Promise<boolean>) | undefined;
  /** Invoked immediately before quarantining a stale published-path occupant. */
  beforeStaleSocketQuarantine?: (() => Promise<void> | void) | undefined;
  /** Invoked after the private bind entry is removed and before permissions are secured. */
  beforeSocketChmod?: (() => Promise<void> | void) | undefined;
  /** Invoked after `chmod` and before the final identity verification. */
  afterSocketChmod?: ((path: string) => Promise<void> | void) | undefined;
  /** Invoked immediately before quarantining the owned published socket during `unpublish`. */
  beforeOwnedSocketQuarantine?: (() => Promise<void> | void) | undefined;
  /** Invoked after the private bind path occupant is quarantined during `unpublish`. */
  afterPrivateSocketQuarantine?: (() => Promise<void> | void) | undefined;
}

export interface PublishedIpcServer {
  /** The address a client connects to — a filesystem path on POSIX, a pipe name on Windows. */
  readonly address: string;
  /**
   * Reverses whatever `publish` did to make the server reachable at `address`. Does not close
   * `server` itself on every platform's behalf implicitly — the POSIX implementation does, because
   * its close-shield must run while the listener is still live; a caller that needs the `net.Server`
   * closed independently of unpublish should not assume one implies the other beyond what each
   * implementation documents.
   */
  unpublish(): Promise<void>;
}

/**
 * `publish` takes an already-constructed, not-yet-listening `Server` rather than constructing one
 * itself: the caller owns the connection-handling callback passed to `createServer`, and the
 * publisher owns only how that server becomes reachable at `address` and how it stops being so.
 */
export interface IpcServerPublisher {
  publish(server: Server, address: string, options?: PublishOptions): Promise<PublishedIpcServer>;
}
