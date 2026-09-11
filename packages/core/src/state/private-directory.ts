import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';
import type { Remediation } from '@wtm/protocol';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../file-trust-policy';

export interface PrivateDirectory {
  path: string;
  identity: PrivateDirectoryIdentity;
}

export interface PrivateDirectoryIdentity {
  device: number;
  inode: number;
  mode: number;
  uid: number;
}

/**
 * `WTM_PRIVATE_DIRECTORY_UNSAFE` is a registered `WtmErrorCode` in exit class 2. It is raised only
 * for a directory that is a symbolic link, not a directory, another user's, or readable by others,
 * because each of those stays true until a person changes it, and a supervised daemon stops on it.
 *
 * `WTM_PRIVATE_DIRECTORY_UNAVAILABLE` is deliberately *not* registered. It covers a directory that
 * could not be read or opened, or changed while it was being checked. That may be a disk or mount
 * that is not there yet, so the failure has to stay uncoded and be retried (todo item 51).
 */
export type PrivateDirectoryErrorCode = 'WTM_PRIVATE_DIRECTORY_UNSAFE' | 'WTM_PRIVATE_DIRECTORY_UNAVAILABLE';

export class PrivateDirectoryError extends Error {
  readonly code: PrivateDirectoryErrorCode;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;
  readonly remediation: readonly Remediation[];

  /**
   * Says which directory failed and what about it failed. WTM keeps its state where only this
   * user can reach it, and refusing without naming the directory leaves a reader with a policy
   * they cannot act on — the fix is almost always one `chmod` on one path.
   */
  constructor(
    path?: string,
    reason?: string,
    classification: { unsafe?: boolean; remediation?: readonly Remediation[] } = {},
  ) {
    const unsafe = classification.unsafe === true;
    // "Unsafe" only for the verdict a person has to act on. The rest is retried, and the log line
    // should not send anyone looking for a permission problem that is not there.
    const verdict = unsafe ? 'unsafe' : 'unavailable';
    super(path === undefined
      ? `WTM private directory is ${verdict}.`
      : `WTM private directory is ${verdict}: ${path} ${reason ?? 'is not a directory only you can read'}.`);
    this.name = 'PrivateDirectoryError';
    this.code = unsafe ? 'WTM_PRIVATE_DIRECTORY_UNSAFE' : 'WTM_PRIVATE_DIRECTORY_UNAVAILABLE';
    this.context = {
      ...(path === undefined ? {} : { path }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.remediation = classification.remediation ?? [];
  }
}

/** A refusal only a person can clear. No remedy is suggested: the right one depends on why. */
function unsafeDirectory(path: string, reason: string): PrivateDirectoryError {
  return new PrivateDirectoryError(path, reason, { unsafe: true });
}

/**
 * The one refusal with a single obvious remedy, which the message already names. `@wtm/core`
 * does not know the operating system, so the remediation is exactly as platform-blind as that
 * message has always been.
 */
function readableByOthers(path: string, stat: Stats): PrivateDirectoryError {
  return new PrivateDirectoryError(
    path,
    `is readable by others (mode ${(stat.mode & 0o7777).toString(8)}); run chmod 700 on it`,
    { unsafe: true, remediation: [{ kind: 'command-suggestion', argv: ['chmod', '700', path] }] },
  );
}

/**
 * Creates a WTM-owned 0700 directory below a private current-user anchor and
 * returns the identity that callers must revalidate before pathname-sensitive
 * operations. Existing symlinked or permissive paths are never repaired.
 */
export async function ensurePrivateDirectory(
  directoryPath: string,
  fileTrust: FileTrustPolicy = defaultCoreFileTrustPolicy,
): Promise<PrivateDirectory> {
  if (directoryPath.trim() === '') throw new PrivateDirectoryError();
  const target = resolve(directoryPath);
  await assertNoSymlinkComponents(target, fileTrust);
  const components: string[] = [];
  let anchor = target;

  while (true) {
    const stat = await lstat(anchor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PrivateDirectoryError();
    });
    if (stat !== undefined) {
      // An anchor above the target is only where WTM would create its directory. See
      // `assertPrivateDirectory` for why that changes what another user's ownership means.
      const established = await inspectPrivateDirectory(anchor, fileTrust, stat, { ancestor: components.length > 0 });
      let current = established.path;
      const identities = [established];
      for (const component of components.reverse()) {
        current = join(current, component);
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw new PrivateDirectoryError();
        });
        identities.push(await inspectPrivateDirectory(current, fileTrust));
      }
      await assertNoSymlinkComponents(target, fileTrust);
      for (const directory of identities) await verifyPrivateDirectory(directory, fileTrust);
      return identities.at(-1)!;
    }
    const parent = dirname(anchor);
    if (parent === anchor) throw new PrivateDirectoryError();
    components.push(basename(anchor));
    anchor = parent;
  }
}

/** Rejects a symlink in any already-existing lexical path component. */
async function assertNoSymlinkComponents(target: string, fileTrust: FileTrustPolicy): Promise<void> {
  const root = parse(target).root;
  let current = root;
  let belowPrivateAnchor = false;
  if (!fileTrust.currentIdentityAvailable()) throw new PrivateDirectoryError();
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PrivateDirectoryError();
    });
    if (stat === undefined) return;
    const ownedByCurrentUser = await fileTrust.isOwnedByCurrentUser(stat, current);
    if (stat.isSymbolicLink() && (belowPrivateAnchor || ownedByCurrentUser)) {
      throw unsafeDirectory(current, 'is a symbolic link');
    }
    if (belowPrivateAnchor) {
      if (!stat.isDirectory()) throw unsafeDirectory(current, 'is not a directory');
      if (!ownedByCurrentUser) throw unsafeDirectory(current, 'belongs to another user');
      if (!(await fileTrust.isWritableOnlyByOwner(stat, current, 0o077))) throw readableByOthers(current, stat);
    }
    // macOS exposes /var as a root-owned system symlink. System ancestors are
    // outside WTM's authority; once an owned 0700 anchor is reached, every
    // remaining lexical component is required to be a real directory.
    if (
      !stat.isSymbolicLink() && stat.isDirectory() && ownedByCurrentUser
      && (await fileTrust.isWritableOnlyByOwner(stat, current, 0o077))
    ) {
      belowPrivateAnchor = true;
    }
  }
}

export async function verifyPrivateDirectory(
  directory: PrivateDirectory,
  fileTrust: FileTrustPolicy = defaultCoreFileTrustPolicy,
): Promise<void> {
  const stat = await lstat(directory.path).catch(() => {
    throw new PrivateDirectoryError();
  });
  const current = await inspectPrivateDirectory(directory.path, fileTrust, stat);
  if (!sameDirectory(directory.identity, current.identity)) throw new PrivateDirectoryError();
}

async function inspectPrivateDirectory(
  path: string,
  fileTrust: FileTrustPolicy,
  initial?: Stats,
  options: { ancestor?: boolean } = {},
): Promise<PrivateDirectory> {
  const before = initial ?? await lstat(path).catch(() => {
    throw new PrivateDirectoryError(path, 'cannot be read');
  });
  await assertPrivateDirectory(before, fileTrust, path, options);
  const canonicalPath = await realpath(path).catch(() => {
    throw new PrivateDirectoryError(path, 'cannot be resolved');
  });
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
    throw new PrivateDirectoryError();
  });
  try {
    const opened = await handle.stat().catch(() => {
      throw new PrivateDirectoryError();
    });
    // Descriptor metadata does not carry ACL ownership on every host. Keep the pathname for
    // policy inspection, then bind it back to this descriptor with the identity checks below.
    await assertPrivateDirectory(opened, fileTrust, canonicalPath, options);
    const after = await lstat(canonicalPath).catch(() => {
      throw new PrivateDirectoryError();
    });
    if (!sameDirectoryStats(before, opened) || !sameDirectoryStats(opened, after)) {
      throw new PrivateDirectoryError();
    }
    return {
      path: canonicalPath,
      identity: { device: opened.dev, inode: opened.ino, mode: opened.mode, uid: opened.uid },
    };
  } finally {
    await handle.close();
  }
}

/**
 * `ancestor` marks the nearest existing directory above a target that does not exist yet.
 *
 * Another user's ownership means something different there. Take a home directory on a volume
 * that is not mounted yet: the walk up stops at the root-owned `/home` or `/Volumes/<disk>`, and
 * that is not a directory anyone has to fix. It is one WTM cannot create in *yet*, so it stays
 * retryable, and a supervised daemon comes up once the volume appears (todo item 51). A target
 * that itself belongs to another user is still permanent, and so is an ancestor that is this
 * user's but too permissive, because only a person changes either.
 *
 * So is another user's directory *below* one of this user's private directories. No volume mounts
 * there, and `assertNoSymlinkComponents` refuses it before this function is reached.
 */
async function assertPrivateDirectory(
  stat: Stats,
  fileTrust: FileTrustPolicy,
  path: string,
  options: { ancestor?: boolean } = {},
): Promise<void> {
  if (!fileTrust.currentIdentityAvailable()) throw new PrivateDirectoryError();
  if (!stat.isDirectory()) throw unsafeDirectory(path, 'is not a directory');
  if (!(await fileTrust.isOwnedByCurrentUser(stat, path))) {
    throw options.ancestor === true
      ? new PrivateDirectoryError(path, 'belongs to another user, so WTM cannot create its directory there yet')
      : unsafeDirectory(path, 'belongs to another user');
  }
  if (!(await fileTrust.isWritableOnlyByOwner(stat, path, 0o077))) throw readableByOthers(path, stat);
}

function sameDirectoryStats(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

function sameDirectory(left: PrivateDirectoryIdentity, right: PrivateDirectoryIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.uid === right.uid;
}
