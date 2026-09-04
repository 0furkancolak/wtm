import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  withRepositoryOperationLease,
  type ProcessStartTimeReader,
  type RepositoryOperationLeaseStore,
} from '../analysis/operation-lease';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../file-trust-policy';
import { pinInode, type InodePin, type ResourceGuard } from './guard';

export interface ResourceSandboxIdentity {
  id: string;
  root: string;
  generation: string;
  dev: number;
  ino: number;
  uid: number;
}

export type GcObjectState = 'READY' | 'STALE' | 'ORPHANED' | 'QUARANTINED' | 'REMOVED';

export interface GcEvidence {
  storageObjectId: string;
  path: string;
  sandboxId: string;
  sandboxRoot: string;
  sandboxGeneration: string;
  dev: number;
  ino: number;
  uid: number;
  kind: 'file' | 'directory';
  state: GcObjectState;
  retention: 'ephemeral' | 'persistent';
  referenceCount: number;
  owned: boolean;
  lastUsedAt: string;
  logicalBytes: number;
  allocatedBytes: number;
  cleanupLeaseToken?: string | null;
}

export type GcExclusionReason =
  | 'live-reference'
  | 'unknown-ownership'
  | 'persistent'
  | 'minimum-age'
  | 'active-cleanup-lease'
  | 'not-stale'
  | 'sandbox-identity-mismatch'
  | 'unsafe-path';

export interface GcCandidate extends GcEvidence {}

export interface GcPlan {
  version: 1;
  sandbox: ResourceSandboxIdentity;
  plannedAt: string;
  minimumAgeMs: number;
  candidates: GcCandidate[];
  excluded: Array<{ storageObjectId: string; path: string; reason: GcExclusionReason }>;
}

export interface BuildGcPlanInput {
  sandbox: ResourceSandboxIdentity;
  records: readonly GcEvidence[];
  now: string;
  minimumAgeMs?: number;
}

export interface GcLeaseCoordinator {
  acquire(candidate: Pick<GcCandidate,
    'storageObjectId' | 'sandboxId' | 'sandboxGeneration' | 'path' | 'dev' | 'ino' | 'uid' | 'kind' | 'state' | 'retention'
  >, token: string): Promise<boolean>;
  renew(candidate: Pick<GcCandidate,
    'storageObjectId' | 'sandboxId' | 'sandboxGeneration' | 'path' | 'dev' | 'ino' | 'uid' | 'kind' | 'state' | 'retention'
  >, token: string): Promise<boolean>;
  release(storageObjectId: string, token: string, preserveReservation?: boolean): Promise<void>;
  finalize(entry: GcJournalEntry, token: string): Promise<boolean>;
}

export type GcJournalPhase = 'prepared' | 'linked' | 'unlinking' | 'quarantined' | 'deleting' | 'deleted' | 'finalized';

interface QuarantineContainerIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}

export interface GcJournalEntry {
  operationId: string;
  storageObjectId: string;
  phase: GcJournalPhase;
  originalPath: string;
  quarantinePath: string | null;
  dev: number;
  ino: number;
  uid: number;
  sandboxId: string;
  sandboxGeneration: string;
  kind: GcEvidence['kind'];
  quarantineContainer: QuarantineContainerIdentity | null;
}

export interface GcJournal {
  record(entry: GcJournalEntry): Promise<void>;
}

export interface GcHooks {
  afterContainerCreated?(candidate: GcCandidate, containerPath: string): Promise<void> | void;
  beforeQuarantine?(candidate: GcCandidate): Promise<void> | void;
  afterFileLink?(candidate: GcCandidate, quarantinePath: string): Promise<void> | void;
  beforeFileUnlink?(candidate: GcCandidate, quarantinePath: string): Promise<void> | void;
  afterFileUnlink?(candidate: GcCandidate, quarantinePath: string): Promise<void> | void;
  afterQuarantine?(candidate: GcCandidate, quarantinePath: string): Promise<void> | void;
  beforeAbsentFinalize?(candidate: GcCandidate): Promise<void> | void;
  beforeContainerCleanup?(containerPath: string): Promise<void> | void;
}

/**
 * How `applyGcPlan`'s destructive path serializes against the other operations that can destroy
 * repository state — `remove`, and in the future `repair`.
 *
 * A GC plan is scoped to one resource sandbox, which lives under a workspace rather than under
 * any one repository (`packages/cli/src/commands/resource-production.ts` builds it from
 * `<workspaceRoot>/.resources`), so there is no single repository a plan is inherently "for". The
 * caller — the one place that still knows which repositories share this workspace — names them
 * here, and every one of them is held for the apply so that a `remove` or a future `repair` on
 * any of them cannot race this GC. A workspace with no registered repository has nothing to
 * protect, and `repositoryIds` is simply empty then.
 */
export interface GcRepositoryLeaseInput {
  store: RepositoryOperationLeaseStore;
  readProcessStartTime: ProcessStartTimeReader;
  repositoryIds: readonly string[];
}

export interface ApplyGcOptions {
  guard: ResourceGuard;
  apply?: boolean;
  lease?: GcLeaseCoordinator;
  journal?: GcJournal;
  hooks?: GcHooks;
  maxEntries?: number;
  maxDepth?: number;
  fileTrust?: FileTrustPolicy;
  /** Omitting this runs the apply without repository-operation serialization. Dry runs never need it. */
  repositoryLease?: GcRepositoryLeaseInput;
}

export interface RecoverGcOptions {
  guard: ResourceGuard;
  lease: GcLeaseCoordinator;
  journal: GcJournal;
  hooks?: GcHooks;
  maxEntries?: number;
  maxDepth?: number;
  fileTrust?: FileTrustPolicy;
}

export type GcItemResult =
  | { storageObjectId: string; path: string; outcome: 'would-delete' | 'deleted' | 'already-absent' }
  | {
    storageObjectId: string;
    path: string;
    outcome: 'failed' | 'lease-contended';
    phase: 'validation' | GcJournalPhase;
    quarantinePath?: string;
    error: { code: 'RESOURCE_PATH_DENIED' | 'RESOURCE_CLEANUP_FAILED'; message: string };
  };

export interface GcApplyResult {
  dryRun: boolean;
  items: GcItemResult[];
}

export function buildGcPlan(input: BuildGcPlanInput): GcPlan {
  if (!Number.isFinite(input.minimumAgeMs ?? 0) || (input.minimumAgeMs ?? 0) < 0) {
    throw new RangeError('GC minimumAgeMs must be a non-negative finite number');
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError('GC now must be an ISO timestamp');
  const minimumAgeMs = input.minimumAgeMs ?? 0;
  const candidates: GcCandidate[] = [];
  const excluded: GcPlan['excluded'] = [];

  for (const record of input.records) {
    const reason = exclusionReason(record, input.sandbox, now, minimumAgeMs);
    if (reason === null) candidates.push({ ...record, path: resolve(record.path) });
    else excluded.push({ storageObjectId: record.storageObjectId, path: record.path, reason });
  }
  candidates.sort(compareEvidence);
  excluded.sort((left, right) => comparePathId(left.path, left.storageObjectId, right.path, right.storageObjectId));
  return {
    version: 1,
    sandbox: { ...input.sandbox, root: resolve(input.sandbox.root) },
    plannedAt: new Date(now).toISOString(),
    minimumAgeMs,
    candidates,
    excluded,
  };
}

export const planResourceGc = buildGcPlan;

export async function applyGcPlan(plan: GcPlan, options: ApplyGcOptions): Promise<GcApplyResult> {
  const dryRun = options.apply !== true;
  const items: GcItemResult[] = [];
  const maxEntries = options.maxEntries ?? 10_000;
  const maxDepth = options.maxDepth ?? 64;
  const fileTrust = options.fileTrust ?? defaultCoreFileTrustPolicy;
  await assertSandboxIdentity(plan.sandbox, fileTrust);

  const runCandidates = (): Promise<void> =>
    applyGcCandidates(plan, options, dryRun, items, maxEntries, maxDepth, fileTrust);
  if (!dryRun && options.repositoryLease !== undefined && options.repositoryLease.repositoryIds.length > 0) {
    await withRepositoryGcLeases(options.repositoryLease, runCandidates);
  } else {
    await runCandidates();
  }
  return { dryRun, items };
}

async function applyGcCandidates(
  plan: GcPlan,
  options: ApplyGcOptions,
  dryRun: boolean,
  items: GcItemResult[],
  maxEntries: number,
  maxDepth: number,
  fileTrust: FileTrustPolicy,
): Promise<void> {
  for (const candidate of plan.candidates) {
    let phase: 'validation' | GcJournalPhase = 'validation';
    let quarantinePath: string | undefined;
    let leaseToken: string | undefined;
    /**
     * A live reference to the object this iteration validated, held until the quarantine move.
     *
     * `assertCandidateIdentity` compares `(dev, ino, uid)`, which stops being an identity the
     * moment the object it describes is deleted: on ext4 and tmpfs the number is reissued at once,
     * so the `rm` and re-create that `beforeQuarantine` performs handed the old checks a stranger
     * they called the candidate, and the GC deleted it. The pin is what makes the number mean
     * something again, and `holds` refuses on the unlink itself. See `InodePin`.
     *
     * It is released before the deletion, not after: past the quarantine move WTM is unlinking the
     * object on purpose, and a liveness check there would refuse the GC's own work.
     */
    let pin: InodePin | null = null;
    try {
      const authorization = await options.guard.authorize(candidate.path, 'delete');
      const current = await lstatIfExists(candidate.path);
      if (current === null) {
        if (dryRun) {
          items.push({ storageObjectId: candidate.storageObjectId, path: candidate.path, outcome: 'already-absent' });
          continue;
        }
        if (options.lease === undefined || options.journal === undefined) {
          throw cleanupFailure('GC apply requires a SQLite-backed cleanup lease and journal.', { storageObjectId: candidate.storageObjectId });
        }
        leaseToken = randomUUID();
        if (!await options.lease.acquire(candidate, leaseToken)) {
          items.push({
            storageObjectId: candidate.storageObjectId, path: candidate.path, outcome: 'lease-contended', phase,
            error: { code: 'RESOURCE_CLEANUP_FAILED', message: 'Another GC owns the cleanup lease.' },
          });
          leaseToken = undefined;
          continue;
        }
        const operationId = randomUUID();
        phase = 'prepared';
        await options.journal.record(journalEntry(operationId, candidate, phase, null, null));
        await options.hooks?.beforeAbsentFinalize?.(candidate);
        await options.guard.revalidate(authorization);
        if (await lstatIfExists(candidate.path) !== null) {
          throw cleanupFailure('A GC target appeared immediately before absent finalization.', { path: candidate.path });
        }
        const finalizedEntry = journalEntry(operationId, candidate, 'finalized', null, null);
        if (!await options.lease.finalize(finalizedEntry, leaseToken)) {
          throw cleanupFailure('Atomic absent resource finalization lost its exact lease or journal.', {
            storageObjectId: candidate.storageObjectId,
          });
        }
        phase = 'finalized';
        items.push({ storageObjectId: candidate.storageObjectId, path: candidate.path, outcome: 'already-absent' });
        leaseToken = undefined;
        continue;
      }
      assertCandidateIdentity(candidate, current, fileTrust);
      pin = await pinInode(candidate.path);
      if (pin === null || !await pin.holds(current)) {
        throw cleanupFailure('A GC candidate could not be held for the duration of its removal.', { path: candidate.path });
      }
      await options.guard.revalidate(authorization);
      if (dryRun) {
        items.push({ storageObjectId: candidate.storageObjectId, path: candidate.path, outcome: 'would-delete' });
        continue;
      }
      if (options.lease === undefined || options.journal === undefined) {
        throw cleanupFailure('GC apply requires a SQLite-backed cleanup lease and journal.', { storageObjectId: candidate.storageObjectId });
      }
      leaseToken = randomUUID();
      if (!await options.lease.acquire(candidate, leaseToken)) {
        items.push({
          storageObjectId: candidate.storageObjectId,
          path: candidate.path,
          outcome: 'lease-contended',
          phase,
          error: { code: 'RESOURCE_CLEANUP_FAILED', message: 'Another GC owns the cleanup lease.' },
        });
        leaseToken = undefined;
        continue;
      }

      const operationId = randomUUID();
      const quarantineContainer = join(dirname(candidate.path), `.wtm-gc-${randomUUID().replaceAll('-', '')}`);
      const containerAuthorization = await options.guard.authorize(quarantineContainer, 'write');
      await options.guard.revalidate(containerAuthorization);
      quarantinePath = join(quarantineContainer, 'object');
      phase = 'prepared';
      await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, null));
      await mkdir(quarantineContainer, { mode: 0o700 });
      const containerIdentity = quarantineContainerIdentity(quarantineContainer, await lstat(quarantineContainer));
      await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
      await options.hooks?.afterContainerCreated?.(candidate, quarantineContainer);
      await options.hooks?.beforeQuarantine?.(candidate);
      if (!await options.lease.renew(candidate, leaseToken)) {
        throw cleanupFailure('GC cleanup reservation expired before quarantine.', { storageObjectId: candidate.storageObjectId });
      }
      await options.guard.revalidate(authorization);
      const beforeMove = await lstatIfExists(candidate.path);
      if (beforeMove === null) throw cleanupFailure('GC target disappeared before quarantine.', { path: candidate.path });
      assertCandidateShape(candidate, beforeMove, fileTrust);
      // The tuple comparison for this boundary lives inside `holds` and nowhere else, so that
      // breaking the pin turns this red here and not only on the Linux runner.
      if (!await pin.holds(beforeMove)) {
        throw cleanupFailure('The GC candidate was replaced after it was validated.', { path: candidate.path });
      }

      const quarantineAuthorization = await options.guard.authorize(quarantinePath, 'write');
      await options.guard.revalidate(quarantineAuthorization);
      if (await lstatIfExists(quarantinePath) !== null) {
        throw cleanupFailure('A concurrent quarantine winner already exists.', { quarantinePath });
      }
      if (candidate.kind === 'file') {
        try {
          await link(candidate.path, quarantinePath);
        } catch (error) {
          if (isFileError(error, 'EEXIST')) throw cleanupFailure('A concurrent quarantine winner already exists.', { quarantinePath });
          throw error;
        }
        const [linked, originalAfterLink] = await Promise.all([lstat(quarantinePath), lstat(candidate.path)]);
        assertCandidateIdentityWithLinks(candidate, linked, 2);
        assertCandidateIdentityWithLinks(candidate, originalAfterLink, 2);
        phase = 'linked';
        await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
        await options.hooks?.afterFileLink?.(candidate, quarantinePath);
        phase = 'unlinking';
        await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
        await options.hooks?.beforeFileUnlink?.(candidate, quarantinePath);
        if (!await options.lease.renew(candidate, leaseToken)) {
          throw cleanupFailure('GC cleanup reservation expired before original unlink.', { storageObjectId: candidate.storageObjectId });
        }
        await options.guard.revalidateParent(authorization);
        await assertExactTwoLinkTopology(candidate, candidate.path, quarantinePath);
        await unlink(candidate.path);
        const quarantined = await lstat(quarantinePath);
        assertCandidateIdentity(candidate, quarantined, fileTrust);
        await options.hooks?.afterFileUnlink?.(candidate, quarantinePath);
      } else {
        await rename(candidate.path, quarantinePath);
      }
      const moved = await lstat(quarantinePath);
      assertCandidateIdentity(candidate, moved, fileTrust);
      await chmod(quarantinePath, moved.isDirectory() ? 0o700 : 0o600);
      phase = 'quarantined';
      await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
      await options.hooks?.afterQuarantine?.(candidate, quarantinePath);

      if (!await options.lease.renew(candidate, leaseToken)) {
        throw cleanupFailure('GC cleanup reservation expired before deletion.', { storageObjectId: candidate.storageObjectId });
      }

      phase = 'deleting';
      await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
      await deleteExactQuarantine(quarantinePath, candidate, maxEntries, maxDepth, fileTrust, async () => {
        if (!await options.lease?.renew(candidate, leaseToken as string)) {
          throw cleanupFailure('GC cleanup reservation expired during deletion.', { storageObjectId: candidate.storageObjectId });
        }
      });
      phase = 'deleted';
      await options.journal.record(journalEntry(operationId, candidate, phase, quarantinePath, containerIdentity));
      if (!await options.lease.renew(candidate, leaseToken)) {
        throw cleanupFailure('GC cleanup reservation expired before finalization.', { storageObjectId: candidate.storageObjectId });
      }
      const finalizedEntry = journalEntry(
        operationId, candidate, 'finalized', quarantinePath, containerIdentity,
      );
      if (!await options.lease.finalize(finalizedEntry, leaseToken)) {
        throw cleanupFailure('Atomic resource finalization lost its exact lease or journal.', {
          storageObjectId: candidate.storageObjectId,
        });
      }
      phase = 'finalized';
      await options.hooks?.beforeContainerCleanup?.(containerIdentity.path);
      await removeExactQuarantineContainer(containerIdentity);
      items.push({ storageObjectId: candidate.storageObjectId, path: candidate.path, outcome: 'deleted' });
      await options.lease.release(candidate.storageObjectId, leaseToken);
      leaseToken = undefined;
    } catch (error) {
      items.push({
        storageObjectId: candidate.storageObjectId,
        path: candidate.path,
        outcome: 'failed',
        phase,
        ...(quarantinePath === undefined ? {} : { quarantinePath }),
        error: {
          code: hasErrorCode(error, 'RESOURCE_PATH_DENIED') ? 'RESOURCE_PATH_DENIED' : 'RESOURCE_CLEANUP_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      if (leaseToken !== undefined && options.lease !== undefined) {
        const quarantined = phase === 'linked' || phase === 'unlinking' || phase === 'quarantined'
          || phase === 'deleting' || phase === 'deleted'
          || (quarantinePath === undefined ? false : await lstatIfExists(quarantinePath).then((stat) => stat !== null).catch(() => true));
        await options.lease.release(candidate.storageObjectId, leaseToken, quarantined).catch(() => {});
      }
    } finally {
      await pin?.close();
    }
  }
}

/**
 * Holds every repository this GC's workspace registers, one nested lease at a time, so a run that
 * needs more than one behaves like a run that needs one: either all of them are held before
 * `body` starts, or none are, and a colliding `remove`/`repair`/`gc` on any single one refuses the
 * whole apply rather than leaving it holding a partial set.
 */
async function withRepositoryGcLeases(lease: GcRepositoryLeaseInput, body: () => Promise<void>): Promise<void> {
  await acquireGcLeases(lease, [...lease.repositoryIds], body);
}

async function acquireGcLeases(
  lease: GcRepositoryLeaseInput,
  remaining: readonly string[],
  body: () => Promise<void>,
): Promise<void> {
  const [repositoryId, ...rest] = remaining;
  if (repositoryId === undefined) {
    await body();
    return;
  }
  await withRepositoryOperationLease({
    store: lease.store,
    readProcessStartTime: lease.readProcessStartTime,
    repositoryId,
    operation: 'gc',
  }, () => acquireGcLeases(lease, rest, body));
}

export const executeGcPlan = applyGcPlan;

export async function recoverGcJournalEntry(
  entry: GcJournalEntry,
  options: RecoverGcOptions,
): Promise<GcItemResult> {
  const fileTrust = options.fileTrust ?? defaultCoreFileTrustPolicy;
  const token = randomUUID();
  const recoveryCandidate = {
    storageObjectId: entry.storageObjectId,
    sandboxId: entry.sandboxId,
    sandboxGeneration: entry.sandboxGeneration,
    path: entry.originalPath,
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    kind: entry.kind,
    state: 'QUARANTINED' as const,
    retention: 'ephemeral' as const,
  };
  if (entry.phase === 'finalized') {
    try {
      await cleanupFinalizedContainer(entry, recoveryCandidate as GcCandidate, options);
      return { storageObjectId: entry.storageObjectId, path: entry.originalPath, outcome: 'already-absent' };
    } catch (error) {
      return failedRecoveryResult(entry, entry.phase, error);
    }
  }
  if ((entry.phase === 'deleted' || (entry.phase === 'prepared' && entry.quarantinePath === null))
    && (entry.quarantinePath === null || await lstatIfExists(entry.quarantinePath) === null)
    && await lstatIfExists(entry.originalPath) === null) {
    const finalizedEntry = { ...entry, phase: 'finalized' as const };
    if (await options.lease.finalize(finalizedEntry, token)) {
      try {
        await cleanupFinalizedContainer(finalizedEntry, recoveryCandidate as GcCandidate, options);
        return {
          storageObjectId: entry.storageObjectId,
          path: entry.originalPath,
          outcome: entry.phase === 'prepared' ? 'already-absent' : 'deleted',
        };
      } catch (error) {
        return failedRecoveryResult(finalizedEntry, 'finalized', error);
      }
    }
  }
  if (!await options.lease.acquire(recoveryCandidate, token)) {
    return {
      storageObjectId: entry.storageObjectId,
      path: entry.originalPath,
      outcome: 'lease-contended',
      phase: entry.phase,
      ...(entry.quarantinePath === null ? {} : { quarantinePath: entry.quarantinePath }),
      error: { code: 'RESOURCE_CLEANUP_FAILED', message: 'Another GC owns the recovery lease.' },
    };
  }
  let currentEntry = entry;
  try {
    if (entry.quarantinePath === null) {
      if (entry.phase !== 'prepared') {
        throw cleanupFailure('GC journal has no quarantine identity to recover.', { operationId: entry.operationId });
      }
      const authorization = await options.guard.authorize(entry.originalPath, 'delete');
      await options.guard.revalidate(authorization);
      if (await lstatIfExists(entry.originalPath) !== null) {
        throw cleanupFailure('Prepared absent finalization found an original object.', { originalPath: entry.originalPath });
      }
      const finalizedEntry = { ...entry, phase: 'finalized' as const };
      if (!await options.lease.finalize(finalizedEntry, token)) {
        throw cleanupFailure('Atomic prepared-absent recovery finalization lost its exact lease or journal.', {
          storageObjectId: entry.storageObjectId,
        });
      }
      return { storageObjectId: entry.storageObjectId, path: entry.originalPath, outcome: 'already-absent' };
    }
    const recoveryQuarantinePath = entry.quarantinePath;
    const renew = async (message: string): Promise<void> => {
      if (!await options.lease.renew(recoveryCandidate, token)) {
        throw cleanupFailure(message, { storageObjectId: entry.storageObjectId });
      }
    };
    if (entry.phase === 'deleting' && entry.quarantineContainer === null
      && basename(recoveryQuarantinePath) === 'object') {
      await options.guard.authorize(dirname(recoveryQuarantinePath), 'delete');
      const [original, quarantine, container] = await Promise.all([
        lstatIfExists(entry.originalPath),
        lstatIfExists(recoveryQuarantinePath),
        lstatIfExists(dirname(recoveryQuarantinePath)),
      ]);
      if (original === null && quarantine === null && container === null) {
        currentEntry = { ...currentEntry, phase: 'deleted' };
        await options.journal.record(currentEntry);
        await renew('GC recovery reservation expired before finalization.');
        const finalizedEntry = { ...currentEntry, phase: 'finalized' as const };
        if (!await options.lease.finalize(finalizedEntry, token)) {
          throw cleanupFailure('Atomic GC recovery finalization lost its exact lease or journal.', {
            storageObjectId: entry.storageObjectId,
          });
        }
        await options.lease.release(entry.storageObjectId, token);
        return { storageObjectId: entry.storageObjectId, path: entry.originalPath, outcome: 'deleted' };
      }
    }
    const container = await ensureRecoveryContainer(currentEntry, recoveryCandidate as GcCandidate, options);
    if (currentEntry.quarantineContainer === null) {
      currentEntry = { ...currentEntry, quarantineContainer: container };
      await options.journal.record(currentEntry);
    }
    if (currentEntry.phase === 'prepared' || currentEntry.phase === 'linked' || currentEntry.phase === 'unlinking') {
      currentEntry = await resumeQuarantinePrefix(currentEntry, recoveryCandidate as GcCandidate, container, options, renew);
    }

    if (currentEntry.phase === 'quarantined' || currentEntry.phase === 'deleting') {
      const quarantine = await lstatIfExists(recoveryQuarantinePath);
      if (quarantine === null) {
        if (await lstatIfExists(currentEntry.originalPath) !== null) {
          throw cleanupFailure('GC journal quarantine is absent while the original path still exists.', {
            quarantinePath: currentEntry.quarantinePath,
          });
        }
      } else {
        assertCandidateIdentity(recoveryCandidate as GcCandidate, quarantine, fileTrust);
        currentEntry = { ...currentEntry, phase: 'deleting' };
        await options.journal.record(currentEntry);
        await deleteExactQuarantine(
          recoveryQuarantinePath,
          recoveryCandidate as GcCandidate,
          options.maxEntries ?? 10_000,
          options.maxDepth ?? 64,
          fileTrust,
          () => renew('GC recovery reservation expired during deletion.'),
        );
      }
      currentEntry = { ...currentEntry, phase: 'deleted' };
      await options.journal.record(currentEntry);
    }
    if (currentEntry.phase === 'deleted') {
      if (await lstatIfExists(recoveryQuarantinePath) !== null) {
        throw cleanupFailure('Deleted GC journal still has a quarantine object.', { quarantinePath: currentEntry.quarantinePath });
      }
      await renew('GC recovery reservation expired before finalization.');
      const finalizedEntry = { ...currentEntry, phase: 'finalized' as const };
      if (!await options.lease.finalize(finalizedEntry, token)) {
        throw cleanupFailure('Atomic GC recovery finalization lost its exact lease or journal.', {
          storageObjectId: entry.storageObjectId,
        });
      }
      currentEntry = finalizedEntry;
    }
    await options.hooks?.beforeContainerCleanup?.(container.path);
    await removeExactQuarantineContainer(container);
    await options.lease.release(entry.storageObjectId, token);
    return { storageObjectId: entry.storageObjectId, path: entry.originalPath, outcome: 'deleted' };
  } catch (error) {
    const preserveReservation = currentEntry.phase === 'linked' || currentEntry.phase === 'unlinking'
      || currentEntry.phase === 'quarantined'
      || currentEntry.phase === 'deleting' || currentEntry.phase === 'deleted' || (entry.quarantinePath !== null
        && await lstatIfExists(entry.quarantinePath).then((stat) => stat !== null).catch(() => true));
    await options.lease.release(entry.storageObjectId, token, preserveReservation).catch(() => {});
    return {
      storageObjectId: entry.storageObjectId,
      path: entry.originalPath,
      outcome: 'failed',
      phase: currentEntry.phase,
      ...(entry.quarantinePath === null ? {} : { quarantinePath: entry.quarantinePath }),
      error: {
        code: hasErrorCode(error, 'RESOURCE_PATH_DENIED') ? 'RESOURCE_PATH_DENIED' : 'RESOURCE_CLEANUP_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function cleanupFinalizedContainer(
  entry: GcJournalEntry,
  candidate: GcCandidate,
  options: RecoverGcOptions,
): Promise<void> {
  if (entry.quarantinePath === null) return;
  const [original, quarantine] = await Promise.all([
    lstatIfExists(entry.originalPath), lstatIfExists(entry.quarantinePath),
  ]);
  const originalMatchesCandidate = original !== null && matchesCandidateIdentity(candidate, original);
  if (originalMatchesCandidate || quarantine !== null) {
    throw cleanupFailure('Finalized GC evidence still has an original or quarantine object.', {
      originalPath: entry.originalPath, quarantinePath: entry.quarantinePath,
    });
  }
  if (entry.quarantineContainer === null) {
    if (await lstatIfExists(dirname(entry.quarantinePath)) !== null) {
      throw cleanupFailure('Legacy finalized GC evidence cannot identify an existing container.', {
        quarantinePath: entry.quarantinePath,
      });
    }
    return;
  }
  const container = await ensureRecoveryContainer(entry, candidate, options);
  await options.hooks?.beforeContainerCleanup?.(container.path);
  await removeExactQuarantineContainer(container);
}

function failedRecoveryResult(
  entry: GcJournalEntry,
  phase: GcJournalPhase,
  error: unknown,
): GcItemResult {
  return {
    storageObjectId: entry.storageObjectId,
    path: entry.originalPath,
    outcome: 'failed',
    phase,
    ...(entry.quarantinePath === null ? {} : { quarantinePath: entry.quarantinePath }),
    error: {
      code: hasErrorCode(error, 'RESOURCE_PATH_DENIED') ? 'RESOURCE_PATH_DENIED' : 'RESOURCE_CLEANUP_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function ensureRecoveryContainer(
  entry: GcJournalEntry,
  candidate: GcCandidate,
  options: RecoverGcOptions,
): Promise<QuarantineContainerIdentity> {
  const quarantinePath = entry.quarantinePath as string;
  const containerPath = dirname(quarantinePath);
  if (basename(quarantinePath) !== 'object') {
    throw cleanupFailure('GC quarantine does not use its fixed child path.', { quarantinePath });
  }
  const authorization = await options.guard.authorize(containerPath, 'delete');
  let stat = await lstatIfExists(containerPath);
  if (stat === null) {
    if ((entry.phase === 'deleted' || entry.phase === 'finalized') && entry.quarantineContainer !== null
      && await lstatIfExists(quarantinePath) === null) {
      const original = await lstatIfExists(entry.originalPath);
      if (original === null || (entry.phase === 'finalized' && !matchesCandidateIdentity(candidate, original))) {
        return entry.quarantineContainer;
      }
    }
    if (entry.phase !== 'prepared') {
      throw cleanupFailure('GC quarantine container is missing outside the prepared phase.', { containerPath });
    }
    const original = await lstatIfExists(entry.originalPath);
    if (original === null) throw cleanupFailure('Prepared GC recovery is missing both original and container.', { containerPath });
    assertCandidateIdentity(candidate, original, options.fileTrust ?? defaultCoreFileTrustPolicy);
    await options.guard.revalidate(authorization);
    await mkdir(containerPath, { mode: 0o700 });
    stat = await lstat(containerPath);
  }
  const actual = quarantineContainerIdentity(containerPath, stat);
  if (entry.quarantineContainer !== null) assertContainerIdentity(entry.quarantineContainer, stat);
  else {
    const children = await readdir(containerPath);
    if (children.some((name) => name !== 'object')) {
      throw cleanupFailure('Unrecorded quarantine container contains foreign entries.', { containerPath });
    }
  }
  return actual;
}

async function resumeQuarantinePrefix(
  entry: GcJournalEntry,
  candidate: GcCandidate,
  container: QuarantineContainerIdentity,
  options: RecoverGcOptions,
  renew: (message: string) => Promise<void>,
): Promise<GcJournalEntry> {
  const fileTrust = options.fileTrust ?? defaultCoreFileTrustPolicy;
  const quarantinePath = entry.quarantinePath as string;
  const [original, quarantine] = await Promise.all([
    lstatIfExists(entry.originalPath), lstatIfExists(quarantinePath),
  ]);
  if (entry.phase === 'linked') {
    if (original === null || quarantine === null || candidate.kind !== 'file') {
      throw cleanupFailure('Linked GC recovery topology is incomplete.', { originalPath: entry.originalPath, quarantinePath });
    }
    await assertExactTwoLinkTopology(candidate, entry.originalPath, quarantinePath);
  } else if (entry.phase === 'unlinking') {
    if (candidate.kind !== 'file' || quarantine === null) {
      throw cleanupFailure('Unlinking GC recovery topology is incomplete.', { originalPath: entry.originalPath, quarantinePath });
    }
    if (original === null) assertCandidateIdentity(candidate, quarantine, fileTrust);
    else await assertExactTwoLinkTopology(candidate, entry.originalPath, quarantinePath);
  } else if (original !== null && quarantine === null) {
    assertCandidateIdentity(candidate, original, fileTrust);
    const originalAuthorization = await options.guard.authorize(entry.originalPath, 'delete');
    const quarantineAuthorization = await options.guard.authorize(quarantinePath, 'write');
    await options.guard.revalidate(originalAuthorization);
    await options.guard.revalidate(quarantineAuthorization);
    await renew('GC recovery reservation expired before quarantine.');
    if (candidate.kind === 'file') {
      await link(entry.originalPath, quarantinePath);
      await assertExactTwoLinkTopology(candidate, entry.originalPath, quarantinePath);
      entry = { ...entry, phase: 'linked', quarantineContainer: container };
      await options.journal.record(entry);
    } else {
      await rename(entry.originalPath, quarantinePath);
    }
  } else if (original !== null && quarantine !== null && candidate.kind === 'file') {
    await assertExactTwoLinkTopology(candidate, entry.originalPath, quarantinePath);
    entry = { ...entry, phase: 'linked', quarantineContainer: container };
    await options.journal.record(entry);
  } else if (original === null && quarantine !== null) {
    assertCandidateIdentity(candidate, quarantine, fileTrust);
  } else {
    throw cleanupFailure('Prepared GC recovery topology is ambiguous.', { originalPath: entry.originalPath, quarantinePath });
  }
  if (candidate.kind === 'file') {
    if (entry.phase === 'linked') {
      entry = { ...entry, phase: 'unlinking', quarantineContainer: container };
      await options.journal.record(entry);
      await options.hooks?.beforeFileUnlink?.(candidate, quarantinePath);
    }
    if (await lstatIfExists(entry.originalPath) !== null) {
      await renew('GC recovery reservation expired before original unlink.');
      const authorization = await options.guard.authorizeParent(entry.originalPath, 'delete');
      await options.guard.revalidateParent(authorization);
      await assertExactTwoLinkTopology(candidate, entry.originalPath, quarantinePath);
      await unlink(entry.originalPath);
      assertCandidateIdentity(candidate, await lstat(quarantinePath), fileTrust);
      await options.hooks?.afterFileUnlink?.(candidate, quarantinePath);
    } else if (entry.phase !== 'unlinking') {
      throw cleanupFailure('GC file original disappeared before durable unlinking intent.', {
        originalPath: entry.originalPath,
      });
    }
  }
  const quarantined = await lstat(quarantinePath);
  assertCandidateIdentity(candidate, quarantined, fileTrust);
  await chmod(quarantinePath, candidate.kind === 'directory' ? 0o700 : 0o600);
  const result: GcJournalEntry = { ...entry, phase: 'quarantined', quarantineContainer: container };
  await options.journal.record(result);
  return result;
}

function exclusionReason(
  record: GcEvidence,
  sandbox: ResourceSandboxIdentity,
  now: number,
  minimumAgeMs: number,
): GcExclusionReason | null {
  if (!record.owned) return 'unknown-ownership';
  if (record.retention === 'persistent') return 'persistent';
  if (record.referenceCount !== 0) return 'live-reference';
  if (record.cleanupLeaseToken) return 'active-cleanup-lease';
  if (record.state !== 'STALE' && record.state !== 'ORPHANED' && record.state !== 'QUARANTINED') return 'not-stale';
  if (
    record.sandboxId !== sandbox.id
    || resolve(record.sandboxRoot) !== resolve(sandbox.root)
    || record.sandboxGeneration !== sandbox.generation
  ) return 'sandbox-identity-mismatch';
  if (!isSafeCandidatePath(record.path, sandbox.root)) return 'unsafe-path';
  const lastUsed = Date.parse(record.lastUsedAt);
  if (!Number.isFinite(lastUsed) || now - lastUsed < minimumAgeMs) return 'minimum-age';
  return null;
}

function isSafeCandidatePath(path: string, sandboxRoot: string): boolean {
  if (!isAbsolute(path) || resolve(path) !== path || /[$*?{}]/.test(path)) return false;
  const nested = relative(resolve(sandboxRoot), path);
  if (nested === '' || nested === '..' || nested.startsWith(`..${sep}`) || nested.startsWith(sep)) return false;
  return !nested.split(sep).includes('.git');
}

/**
 * `stat.uid !== sandbox.uid`/`stat.uid !== candidate.uid` throughout this file (here and in the
 * three functions below) compare against a **previously observed** value recorded on the sandbox
 * or candidate — a TOCTOU check ("is this still the object I looked at"), not a "does this belong
 * to the current process's user" question. `FileTrustPolicy` answers the latter; it does not
 * apply here, and is deliberately not used for these comparisons. This is a real, known
 * Windows gap rather than an oversight: `fs.Stats.uid` is always `0` there, so a `uid` component
 * in an identity tuple never discriminates on that platform (`(dev, ino)` alone still does the
 * TOCTOU work; only the "swapped for a different *user's* object" half of the protection is
 * unavailable). Recorded, not fixed, in `2026-09-03-windows-trust-and-transport-seam.md`'s
 * "what this increment does not claim".
 */
async function assertSandboxIdentity(sandbox: ResourceSandboxIdentity, fileTrust: FileTrustPolicy): Promise<void> {
  const stat = await lstat(sandbox.root);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== sandbox.dev
    || stat.ino !== sandbox.ino
    || stat.uid !== sandbox.uid
    || !(await fileTrust.isWritableOnlyByOwner(stat, sandbox.root, 0o022))
  ) {
    throw cleanupFailure('The GC sandbox identity or trust boundary changed.', { root: sandbox.root });
  }
}

function assertCandidateIdentity(
  candidate: GcCandidate,
  stat: Awaited<ReturnType<typeof lstat>>,
  fileTrust: FileTrustPolicy,
): void {
  const expectedKind = candidate.kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (
    !expectedKind
    || stat.isSymbolicLink()
    || stat.dev !== candidate.dev
    || stat.ino !== candidate.ino
    || stat.uid !== candidate.uid
    || (stat.isFile() && !fileTrust.isNotSharedByHardLink(stat))
  ) {
    throw cleanupFailure('GC candidate identity changed or is unsafe.', { path: candidate.path });
  }
}

/**
 * Everything `assertCandidateIdentity` checks except the identity itself.
 *
 * Split out for the one boundary that has a pin: the kind, ownership and link-count checks are
 * still this function's, and the "is it the same object" half is delegated to the pin, which is a
 * stronger answer than the tuple and the only one that holds on a filesystem that reissues inode
 * numbers.
 */
function assertCandidateShape(
  candidate: GcCandidate,
  stat: Awaited<ReturnType<typeof lstat>>,
  fileTrust: FileTrustPolicy,
): void {
  const expectedKind = candidate.kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (
    !expectedKind || stat.isSymbolicLink() || stat.uid !== candidate.uid
    || (stat.isFile() && !fileTrust.isNotSharedByHardLink(stat))
  ) {
    throw cleanupFailure('The GC candidate is no longer a safe removal target.', { path: candidate.path });
  }
}

function matchesCandidateIdentity(candidate: GcCandidate, stat: Awaited<ReturnType<typeof lstat>>): boolean {
  return !stat.isSymbolicLink()
    && (candidate.kind === 'directory' ? stat.isDirectory() : stat.isFile())
    && stat.dev === candidate.dev
    && stat.ino === candidate.ino
    && stat.uid === candidate.uid;
}

function assertCandidateIdentityWithLinks(
  candidate: GcCandidate,
  stat: Awaited<ReturnType<typeof lstat>>,
  expectedLinks: number,
): void {
  if (
    candidate.kind !== 'file' || !stat.isFile() || stat.isSymbolicLink()
    || stat.dev !== candidate.dev || stat.ino !== candidate.ino || stat.uid !== candidate.uid
    || stat.nlink !== expectedLinks
  ) throw cleanupFailure('GC file identity changed during no-replace quarantine.', { path: candidate.path });
}

async function assertExactTwoLinkTopology(
  candidate: GcCandidate,
  originalPath: string,
  quarantinePath: string,
): Promise<void> {
  const [original, quarantine] = await Promise.all([lstat(originalPath), lstat(quarantinePath)]);
  assertCandidateIdentityWithLinks(candidate, original, 2);
  assertCandidateIdentityWithLinks(candidate, quarantine, 2);
  if (original.dev !== quarantine.dev || original.ino !== quarantine.ino) {
    throw cleanupFailure('GC file quarantine links do not identify the same inode.', { originalPath, quarantinePath });
  }
}

function quarantineContainerIdentity(
  path: string,
  stat: Awaited<ReturnType<typeof lstat>>,
): QuarantineContainerIdentity {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (Number(stat.mode) & 0o777) !== 0o700) {
    throw cleanupFailure('GC quarantine container is outside its owner-only trust boundary.', { path });
  }
  return {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    uid: Number(stat.uid),
    mode: Number(stat.mode),
  };
}

function assertContainerIdentity(
  expected: QuarantineContainerIdentity,
  actual: Awaited<ReturnType<typeof lstat>>,
): void {
  if (
    !actual.isDirectory() || actual.isSymbolicLink()
    || Number(actual.dev) !== expected.dev || Number(actual.ino) !== expected.ino
    || Number(actual.uid) !== expected.uid || Number(actual.mode) !== expected.mode
  ) throw cleanupFailure('GC quarantine container identity changed.', { path: expected.path });
}

async function removeExactQuarantineContainer(container: QuarantineContainerIdentity): Promise<void> {
  const current = await lstatIfExists(container.path);
  if (current === null) return;
  assertContainerIdentity(container, current);
  if ((await readdir(container.path)).length !== 0) {
    throw cleanupFailure('GC quarantine container is not empty at cleanup.', { path: container.path });
  }
  const final = await lstat(container.path);
  assertContainerIdentity(container, final);
  await rmdir(container.path);
}

async function deleteExactQuarantine(
  quarantinePath: string,
  candidate: GcCandidate,
  maxEntries: number,
  maxDepth: number,
  fileTrust: FileTrustPolicy,
  beforeMutation: () => Promise<void>,
): Promise<void> {
  let entries = 0;
  const removeEntry = async (path: string, depth: number, root: boolean): Promise<void> => {
    if (depth > maxDepth || ++entries > maxEntries) throw cleanupFailure('GC traversal exceeded its configured bound.', { quarantinePath });
    const stat = await lstat(path);
    if (stat.uid !== candidate.uid || stat.isSymbolicLink()) {
      throw cleanupFailure('GC quarantine contains an unowned or symbolic-link entry.', { path });
    }
    if (root) assertCandidateIdentity(candidate, stat, fileTrust);
    if (stat.isFile()) {
      if (!fileTrust.isNotSharedByHardLink(stat)) throw cleanupFailure('GC refuses hardlinked files.', { path });
      await beforeMutation();
      await unlink(path);
      return;
    }
    if (!stat.isDirectory()) throw cleanupFailure('GC refuses special files.', { path });
    for (const child of (await readdir(path)).sort(codeUnitCompare)) await removeEntry(join(path, child), depth + 1, false);
    const final = await lstat(path);
    if (final.dev !== stat.dev || final.ino !== stat.ino || final.uid !== stat.uid) {
      throw cleanupFailure('GC quarantine changed during traversal.', { path });
    }
    await beforeMutation();
    await rmdir(path);
  };
  await removeEntry(quarantinePath, 0, true);
}

function journalEntry(
  operationId: string,
  candidate: GcCandidate,
  phase: GcJournalPhase,
  quarantinePath: string | null,
  quarantineContainer: QuarantineContainerIdentity | null,
): GcJournalEntry {
  return {
    operationId,
    storageObjectId: candidate.storageObjectId,
    phase,
    originalPath: candidate.path,
    quarantinePath,
    dev: candidate.dev,
    ino: candidate.ino,
    uid: candidate.uid,
    sandboxId: candidate.sandboxId,
    sandboxGeneration: candidate.sandboxGeneration,
    kind: candidate.kind,
    quarantineContainer,
  };
}

function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((error) => {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  });
}

function compareEvidence(left: GcEvidence, right: GcEvidence): number {
  return comparePathId(left.path, left.storageObjectId, right.path, right.storageObjectId);
}

function comparePathId(leftPath: string, leftId: string, rightPath: string, rightId: string): number {
  return codeUnitCompare(leftPath, rightPath) || codeUnitCompare(leftId, rightId);
}

function cleanupFailure(message: string, context: Record<string, unknown>): Error & { code: 'RESOURCE_CLEANUP_FAILED' } {
  return Object.assign(new Error(message), { code: 'RESOURCE_CLEANUP_FAILED' as const, context });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
