import { lstat, opendir, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pinInode, type InodePin } from '../resources/guard';

export type WorktreeReclaimableReason = 'entry-budget' | 'time-budget' | 'depth-budget' | 'aborted'
  | 'missing' | 'symlink-root' | 'unreadable' | 'changed' | 'allocation-unavailable' | 'invalid-input'
  | 'mount-evidence-unavailable' | 'mount-evidence-changed';

export interface WorktreeReclaimableMeasurement {
  status: 'complete' | 'partial' | 'unavailable';
  /** Null unless the bounded scan completed. Never permission to remove a worktree. */
  estimatedBytes: number | null;
  observedExclusiveBytes: number;
  entries: number;
  excluded: { hardlinks: number; symlinks: number; policyPaths: number; crossDevice: number; mounts: number };
  reason: WorktreeReclaimableReason | null;
  basis: 'exclusive-file-allocation-estimate';
}

export interface WorktreeReclaimableInput {
  root: string;
  /** Optional mount-namespace evidence, supplied by the composition root. */
  readMountBoundaries?: ((root: string, checkBudget: () => void) => Promise<{
    paths: ReadonlySet<string>;
    fingerprint: string;
  }>) | undefined;
  /** Resolved retained-resource paths, or paths relative to root. Nothing outside root is walked. */
  excludedPaths?: readonly string[] | undefined;
  maxEntries?: number | undefined;
  maxDurationMs?: number | undefined;
  /** A shared absolute performance.now() deadline bounds multiple worktrees together. */
  deadline?: number | undefined;
  signal?: AbortSignal | undefined;
}

interface DirectoryInspection { path: string; metadata: BigIntStats; pin: InodePin }
interface EntryInspection { path: string; metadata: BigIntStats }

class MeasurementStopped extends Error {
  constructor(readonly status: 'partial' | 'unavailable', readonly reason: WorktreeReclaimableReason) {
    super(reason);
  }
}

/**
 * Estimate allocated bytes of ordinary, single-link files inside one worktree. Git metadata,
 * retained resource paths, hardlinks, symlink targets and other devices are excluded. Supplied
 * mount-namespace evidence additionally excludes same-device mounts below the worktree root.
 * Allocation is not guaranteed freed space: clones, filesystem snapshots and compression can
 * share blocks without increasing nlink. Directory allocation and symlink storage are omitted.
 *
 * This reads metadata only, holds inode pins while descending, and rejects detected path/content
 * changes. It is an observation, not an atomic filesystem snapshot or removal authorization.
 * Portable directory iteration has no openat primitive; a race can change the pathname while
 * opendir is opening it. Before consuming entries the parent pins and metadata are revalidated.
 *
 * Time/abort limits are cooperative between filesystem operations; an already pending OS read
 * cannot be interrupted. No cache, background task, file contents or database state is involved.
 */
export async function measureWorktreeReclaimable(input: WorktreeReclaimableInput): Promise<WorktreeReclaimableMeasurement> {
  const result: WorktreeReclaimableMeasurement = {
    status: 'unavailable', estimatedBytes: null, observedExclusiveBytes: 0, entries: 0,
    excluded: { hardlinks: 0, symlinks: 0, policyPaths: 0, crossDevice: 0, mounts: 0 },
    reason: null, basis: 'exclusive-file-allocation-estimate',
  };
  const maxEntries = input.maxEntries ?? 20_000;
  const maxDurationMs = input.maxDurationMs ?? 2_000;
  const deadline = Math.min(input.deadline ?? Number.POSITIVE_INFINITY, performance.now() + maxDurationMs);
  const checked: EntryInspection[] = [];
  const active: DirectoryInspection[] = [];
  const checkBudget = () => {
    if (input.signal?.aborted) throw new MeasurementStopped('partial', 'aborted');
    if (performance.now() >= deadline) throw new MeasurementStopped('partial', 'time-budget');
  };
  const metadata = async (path: string) => {
    checkBudget();
    try { return await lstat(path, { bigint: true }); }
    catch (error) {
      throw new MeasurementStopped('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'changed' : 'unreadable');
    }
  };
  const verifyActive = async () => {
    for (const directory of active) {
      const current = await metadata(directory.path);
      if (current.isSymbolicLink() || !sameMetadata(directory.metadata, current) || !await directory.pin.holds(current)) {
        throw new MeasurementStopped('unavailable', 'changed');
      }
    }
  };
  try {
    if (input.root.trim() === '' || !Number.isSafeInteger(maxEntries) || maxEntries < 0
      || !Number.isFinite(maxDurationMs) || maxDurationMs < 0 || Number.isNaN(deadline)) {
      throw new MeasurementStopped('unavailable', 'invalid-input');
    }
    checkBudget();
    const requested = resolve(input.root);
    let initial;
    try { initial = await lstat(requested, { bigint: true }); }
    catch (error) {
      throw new MeasurementStopped('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
    }
    if (initial.isSymbolicLink()) throw new MeasurementStopped('unavailable', 'symlink-root');
    if (!initial.isDirectory()) throw new MeasurementStopped('unavailable', 'unreadable');
    const root = await realpath(requested);
    const canonical = await metadata(root);
    if (!sameMetadata(initial, canonical)) throw new MeasurementStopped('unavailable', 'changed');
    const mountSnapshot = async () => {
      if (input.readMountBoundaries === undefined) return null;
      try { return await input.readMountBoundaries(root, checkBudget); }
      catch (error) {
        if (error instanceof MeasurementStopped) throw error;
        throw new MeasurementStopped('unavailable', 'mount-evidence-unavailable');
      }
    };
    const mounts = await mountSnapshot();
    const excludedPaths = (input.excludedPaths ?? []).map((path) => {
      const absolute = resolve(requested, path);
      const rel = relative(requested, absolute);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        // Outside resources cannot contribute to this worktree's footprint.
        return null;
      }
      return resolve(root, rel);
    }).filter((path): path is string => path !== null);

    const walk = async (path: string, depth: number): Promise<void> => {
      checkBudget();
      if (result.entries >= maxEntries) throw new MeasurementStopped('partial', 'entry-budget');
      if (depth > 64) throw new MeasurementStopped('partial', 'depth-budget');
      result.entries += 1;
      if (excludedPaths.some((excluded) => contains(excluded, path))) {
        result.excluded.policyPaths += 1;
        return;
      }
      if (mounts?.paths.has(path)) { result.excluded.mounts += 1; return; }
      await verifyActive();
      const stat = await metadata(path);
      await verifyActive();
      if (stat.isSymbolicLink()) { result.excluded.symlinks += 1; return; }
      if (stat.dev !== initial.dev) { result.excluded.crossDevice += 1; return; }
      checked.push({ path, metadata: stat });
      if (stat.isFile()) {
        if (stat.nlink !== 1n) { result.excluded.hardlinks += 1; return; }
        if (typeof stat.blocks !== 'bigint' || stat.blocks < 0n) throw new MeasurementStopped('unavailable', 'allocation-unavailable');
        const bytes = Number(stat.blocks * 512n);
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(result.observedExclusiveBytes + bytes)) {
          throw new MeasurementStopped('unavailable', 'allocation-unavailable');
        }
        result.observedExclusiveBytes += bytes;
        return;
      }
      if (!stat.isDirectory()) return;
      let pin: InodePin | null = null;
      let directory: Awaited<ReturnType<typeof opendir>> | undefined;
      let pushed = false;
      try {
        pin = await pinInode(path);
        if (pin === null || !await pin.holds(stat)) throw new MeasurementStopped('unavailable', 'changed');
        active.push({ path, metadata: stat, pin });
        pushed = true;
        await verifyActive();
        directory = await opendir(path, { bufferSize: 16 });
        // opendir may race with a directory replacement; do not consume it before rechecking.
        await verifyActive();
        while (true) {
          checkBudget();
          await verifyActive();
          const entry = await directory.read();
          await verifyActive();
          if (entry === null) break;
          // Administrative metadata is shared with the main checkout and is never reclaimed here.
          if (entry.name === '.git') continue;
          if (entry.name === '.' || entry.name === '..' || entry.name.includes(sep)) {
            throw new MeasurementStopped('unavailable', 'changed');
          }
          await walk(join(path, entry.name), depth + 1);
        }
      } finally {
        if (pushed) active.pop();
        try { await directory?.close(); } finally { await pin?.close(); }
      }
    };
    await walk(root, 0);
    // Changes to already scanned files do not silently leave a completed estimate behind.
    for (const entry of checked) {
      if (!sameMetadata(entry.metadata, await metadata(entry.path))) throw new MeasurementStopped('unavailable', 'changed');
    }
    if (!sameMetadata(initial, await metadata(requested))) throw new MeasurementStopped('unavailable', 'changed');
    if (mounts !== null && (await mountSnapshot())?.fingerprint !== mounts.fingerprint) {
      throw new MeasurementStopped('unavailable', 'mount-evidence-changed');
    }
    checkBudget();
    result.status = 'complete';
    result.estimatedBytes = result.observedExclusiveBytes;
  } catch (error) {
    result.status = error instanceof MeasurementStopped ? error.status : 'unavailable';
    result.reason = error instanceof MeasurementStopped ? error.reason : 'unreadable';
  }
  return result;
}

function sameMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.blocks === right.blocks
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
