import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';

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

export class PrivateDirectoryError extends Error {
  readonly code = 'WTM_PRIVATE_DIRECTORY_UNSAFE' as const;
  readonly context: Record<string, unknown>;

  /**
   * Says which directory failed and what about it failed. WTM keeps its state where only this
   * user can reach it, and refusing without naming the directory leaves a reader with a policy
   * they cannot act on — the fix is almost always one `chmod` on one path.
   */
  constructor(path?: string, reason?: string) {
    super(path === undefined
      ? 'WTM private directory is unsafe.'
      : `WTM private directory is unsafe: ${path} ${reason ?? 'is not a directory only you can read'}.`);
    this.name = 'PrivateDirectoryError';
    this.context = {
      ...(path === undefined ? {} : { path }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

/**
 * Creates a WTM-owned 0700 directory below a private current-user anchor and
 * returns the identity that callers must revalidate before pathname-sensitive
 * operations. Existing symlinked or permissive paths are never repaired.
 */
export async function ensurePrivateDirectory(directoryPath: string): Promise<PrivateDirectory> {
  if (directoryPath.trim() === '') throw new PrivateDirectoryError();
  const target = resolve(directoryPath);
  await assertNoSymlinkComponents(target);
  const components: string[] = [];
  let anchor = target;

  while (true) {
    const stat = await lstat(anchor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PrivateDirectoryError();
    });
    if (stat !== undefined) {
      const established = await inspectPrivateDirectory(anchor, stat);
      let current = established.path;
      const identities = [established];
      for (const component of components.reverse()) {
        current = join(current, component);
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw new PrivateDirectoryError();
        });
        identities.push(await inspectPrivateDirectory(current));
      }
      await assertNoSymlinkComponents(target);
      for (const directory of identities) await verifyPrivateDirectory(directory);
      return identities.at(-1)!;
    }
    const parent = dirname(anchor);
    if (parent === anchor) throw new PrivateDirectoryError();
    components.push(basename(anchor));
    anchor = parent;
  }
}

/** Rejects a symlink in any already-existing lexical path component. */
async function assertNoSymlinkComponents(target: string): Promise<void> {
  const root = parse(target).root;
  let current = root;
  let belowPrivateAnchor = false;
  const currentUserId = process.getuid?.();
  if (currentUserId === undefined) throw new PrivateDirectoryError();
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PrivateDirectoryError();
    });
    if (stat === undefined) return;
    if (stat.isSymbolicLink() && (belowPrivateAnchor || stat.uid === currentUserId)) {
      throw new PrivateDirectoryError(current, 'is a symbolic link');
    }
    if (belowPrivateAnchor) {
      if (!stat.isDirectory()) throw new PrivateDirectoryError(current, 'is not a directory');
      if (stat.uid !== currentUserId) throw new PrivateDirectoryError(current, 'belongs to another user');
      if ((stat.mode & 0o077) !== 0) {
        throw new PrivateDirectoryError(
          current,
          `is readable by others (mode ${(stat.mode & 0o7777).toString(8)}); run chmod 700 on it`,
        );
      }
    }
    // macOS exposes /var as a root-owned system symlink. System ancestors are
    // outside WTM's authority; once an owned 0700 anchor is reached, every
    // remaining lexical component is required to be a real directory.
    if (!stat.isSymbolicLink() && stat.isDirectory()
      && stat.uid === currentUserId && (stat.mode & 0o077) === 0) {
      belowPrivateAnchor = true;
    }
  }
}

export async function verifyPrivateDirectory(directory: PrivateDirectory): Promise<void> {
  const stat = await lstat(directory.path).catch(() => {
    throw new PrivateDirectoryError();
  });
  const current = await inspectPrivateDirectory(directory.path, stat);
  if (!sameDirectory(directory.identity, current.identity)) throw new PrivateDirectoryError();
}

async function inspectPrivateDirectory(path: string, initial?: Stats): Promise<PrivateDirectory> {
  const before = initial ?? await lstat(path).catch(() => {
    throw new PrivateDirectoryError(path, 'cannot be read');
  });
  assertPrivateDirectory(before, path);
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
    assertPrivateDirectory(opened);
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

function assertPrivateDirectory(stat: Stats, path?: string): void {
  const currentUserId = process.getuid?.();
  if (currentUserId === undefined) throw new PrivateDirectoryError();
  if (!stat.isDirectory()) throw new PrivateDirectoryError(path, 'is not a directory');
  if (stat.uid !== currentUserId) throw new PrivateDirectoryError(path, 'belongs to another user');
  if ((stat.mode & 0o077) !== 0) {
    throw new PrivateDirectoryError(
      path,
      `is readable by others (mode ${(stat.mode & 0o7777).toString(8)}); run chmod 700 on it`,
    );
  }
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
