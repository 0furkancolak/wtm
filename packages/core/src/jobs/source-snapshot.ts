import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runGit } from '../git/git-runner';

export interface SourceSnapshot {
  fingerprint: string;
  files: number;
  bytes: number;
  scope: 'git-tracked-and-untracked';
}

export interface SourceSnapshotBudget {
  maxFiles?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export class SourceSnapshotError extends Error {
  readonly code = 'WTM_JOB_SOURCE_CHANGED' as const;
  readonly severity = 'error' as const;
}

/**
 * Evidence for Git-visible sources, not an immutable filesystem snapshot. Ignored outputs and
 * external dependencies are deliberately not traversed. ctime also detects an edit restored to
 * its original bytes; transient created-and-deleted files can still escape this bounded scan.
 * No file contents or paths are retained in the public result.
 */
export async function captureSourceSnapshot(root: string, budget: SourceSnapshotBudget = {}): Promise<SourceSnapshot> {
  const maxFiles = budget.maxFiles ?? 10_000;
  const maxBytes = budget.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = budget.timeoutMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  const checkTime = () => {
    if (Date.now() >= deadline) throw new SourceSnapshotError('Source snapshot time budget exceeded.');
  };
  const git = async (argv: string[]) => {
    checkTime();
    return (await runGit(root, argv, { timeoutMs: Math.max(1, deadline - Date.now()), maxOutputBytes: 4 * 1024 * 1024 })).stdout;
  };
  try {
    const absolute = resolve(root);
    const rootIdentity = await lstat(absolute, { bigint: true });
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new SourceSnapshotError('Source root is not a physical worktree directory.');
    const before = await gitState(git);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const names = [...new Set(decoder.decode(before.names).split('\0').filter(Boolean))].sort();
    if (names.length > maxFiles) throw new SourceSnapshotError('Source snapshot file budget exceeded.');
    const hash = createHash('sha256');
    hash.update('wtm-source-v1\0').update(before.head).update(before.index);
    hash.update(`${rootIdentity.dev}:${rootIdentity.ino}\0`);
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    const inspectedParents = new Map<string, Identity>();
    const verifyParent = async (path: string) => {
      const stat = await lstat(path, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SourceSnapshotError('Source symlink or non-directory parent is unsupported.');
      const prior = inspectedParents.get(path);
      if (prior !== undefined && fileIdentity(prior) !== fileIdentity(stat)) throw new SourceSnapshotError('Source ancestor changed during the snapshot.');
      if (prior === undefined) {
        inspectedParents.set(path, stat);
        hash.update(fileIdentity(stat));
      }
    };
    for (const name of names) {
      checkTime();
      const path = resolve(absolute, name);
      const rel = relative(absolute, path);
      if (isAbsolute(name) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new SourceSnapshotError('Source path escapes the worktree.');
      }
      const segments = rel.split(sep);
      let parent = absolute;
      const parents: string[] = [];
      for (const part of segments.slice(0, -1)) {
        parent = join(parent, part);
        parents.push(parent);
        await verifyParent(parent);
      }
      hash.update(JSON.stringify(name)).update('\0');
      let metadata;
      try { metadata = await lstat(path, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        hash.update('missing\0');
        continue;
      }
      if (metadata.isSymbolicLink()) throw new SourceSnapshotError('Source symlink inputs are unsupported.');
      if (!metadata.isFile()) throw new SourceSnapshotError('Source submodules and non-file inputs are unsupported.');
      if (Number(metadata.size) + bytes > maxBytes) throw new SourceSnapshotError('Source snapshot byte budget exceeded.');
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        for (const ancestor of parents) await verifyParent(ancestor);
        const opened = await handle.stat({ bigint: true });
        if (!sameFile(metadata, opened)) throw new SourceSnapshotError('Source changed while opening a file.');
        hash.update(fileIdentity(opened));
        let offset = 0;
        while (true) {
          checkTime();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (bytesRead === 0) break;
          bytes += bytesRead;
          offset += bytesRead;
          if (bytes > maxBytes) throw new SourceSnapshotError('Source snapshot byte budget exceeded.');
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(opened)
          || fileIdentity(await lstat(path, { bigint: true })) !== fileIdentity(opened)) {
          throw new SourceSnapshotError('Source changed during the snapshot.');
        }
        for (const ancestor of parents) await verifyParent(ancestor);
      } finally { await handle.close(); }
    }
    for (const ancestor of inspectedParents.keys()) { checkTime(); await verifyParent(ancestor); }
    const after = await gitState(git);
    const finalRoot = await lstat(absolute, { bigint: true });
    if (!before.head.equals(after.head) || !before.index.equals(after.index) || !before.names.equals(after.names)
      || !sameFile(rootIdentity, finalRoot) || rootIdentity.ctimeNs !== finalRoot.ctimeNs
      || finalRoot.isSymbolicLink()) throw new SourceSnapshotError('Source worktree or Git index changed during the snapshot.');
    return { fingerprint: hash.digest('hex'), files: names.length, bytes, scope: 'git-tracked-and-untracked' };
  } catch (error) {
    if (error instanceof SourceSnapshotError) throw error;
    throw new SourceSnapshotError('Source snapshot could not be verified safely.');
  }
}

type Identity = { dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint };
function sameFile(a: Pick<Identity, 'dev' | 'ino'>, b: Pick<Identity, 'dev' | 'ino'>): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function fileIdentity(stat: Identity): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}\0`;
}
async function gitState(git: (argv: string[]) => Promise<Buffer>) {
  return {
    head: await git(['rev-parse', '--verify', 'HEAD']),
    index: await git(['ls-files', '--stage', '-z']),
    names: await git(['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z']),
  };
}
