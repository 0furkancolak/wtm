import type { Remediation } from '@wtm/protocol';

/** What was found at a socket path the daemon could not use. */
export type IpcPathOccupant = 'file' | 'foreign-file' | 'directory' | 'symlink' | 'foreign-socket' | 'other';

/**
 * Raised instead of a bare `Error` when the daemon's socket path is occupied by something it will
 * not reclaim (spec `2026-09-09-daemon-startup-crash-loop.md`, decision 2 and R1).
 *
 * It carries a `WtmErrorCode`, so `daemon serve`'s `codedError` puts it in the envelope as is, and
 * its exit class (2) is what makes a supervised daemon stop retrying it.
 */
export class IpcPathUnusableError extends Error {
  readonly code = 'WTM_IPC_PATH_UNUSABLE' as const;
  readonly severity = 'error' as const;
  readonly context: { path: string; occupant: IpcPathOccupant; ownerUid: number | null };
  readonly remediation: readonly Remediation[];

  constructor(path: string, occupant: IpcPathOccupant, ownerUid: number | null) {
    super(messageFor(path, occupant));
    this.name = 'IpcPathUnusableError';
    this.context = { path, occupant, ownerUid };
    // Removing the path is the remedy only for a file of ours or a link (unlinking a link never
    // touches its target). Anything else needs a person to look first.
    this.remediation = occupant === 'file' || occupant === 'symlink'
      ? [{ kind: 'command-suggestion', argv: ['rm', path] }]
      : [{ kind: 'command-suggestion', argv: ['wtm', 'doctor'] }];
  }
}

/** Why the daemon's socket directory was refused. Each stays true until a person changes it. */
export type SocketDirectoryRefusal = 'is a symbolic link' | 'is not a directory' | 'belongs to another user';

/**
 * The daemon's socket directory is one WTM will not use (todo item 51).
 *
 * It uses the same code, message shape and context as core's `PrivateDirectoryError` for the same
 * refusal. The socket directory is one of WTM's private directories like any other, and
 * `@wtm/platform` cannot import `@wtm/core`. There is no remediation: whether to remove a link or
 * a file depends on why it is there, and WTM does not know that.
 */
export class SocketDirectoryUnsafeError extends Error {
  readonly code = 'WTM_PRIVATE_DIRECTORY_UNSAFE' as const;
  readonly severity = 'error' as const;
  readonly context: { path: string; reason: SocketDirectoryRefusal };
  readonly remediation: readonly Remediation[] = [];

  constructor(path: string, reason: SocketDirectoryRefusal) {
    super(`WTM private directory is unsafe: ${path} ${reason}.`);
    this.name = 'SocketDirectoryUnsafeError';
    this.context = { path, reason };
  }
}

/**
 * Another process is already serving at the socket path.
 *
 * Deliberately uncoded, because it clears when that process stops, so a supervisor keeps retrying.
 * It has its own class so `daemon serve` can tell it apart and leave the serving daemon's startup
 * record alone (todo item 51, M9).
 */
export class IpcSocketInUseError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`IPC socket is already in use: ${path}`);
    this.name = 'IpcSocketInUseError';
    this.path = path;
  }
}

function messageFor(path: string, occupant: IpcPathOccupant): string {
  switch (occupant) {
    case 'file':
      return `The WTM daemon socket path is occupied by a file WTM did not leave there: ${path}. `
        + 'Remove it, then run `wtm daemon install` to start the daemon again.';
    case 'symlink':
      return `The WTM daemon socket path is a symbolic link: ${path}. WTM will not follow it. `
        + 'Remove the link, then run `wtm daemon install`.';
    case 'foreign-file':
      return `The WTM daemon socket path holds a file owned by another user: ${path}. WTM will not `
        + 'remove it. The directory is meant to be private to you, so find out how it got there.';
    case 'foreign-socket':
      return `The WTM daemon socket path holds a socket owned by another user: ${path}. WTM will not remove it.`;
    case 'directory':
      return `The WTM daemon socket path is a directory: ${path}. WTM will not remove a directory. `
        + 'Move it aside, then run `wtm daemon install`.';
    case 'other':
      return `The WTM daemon socket path holds something that is neither a socket nor a file: ${path}. `
        + 'WTM will not remove it.';
  }
}
