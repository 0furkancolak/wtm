import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  RepositoryOperationConflictError,
  withRepositoryOperationLease,
  type ProcessStartTimeReader,
  type RepositoryOperationLeaseStore,
} from '../../analysis/operation-lease';
import type {
  RepositoryOperationLease,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseRequest,
  RepositoryOperationLeaseResult,
} from '../../state/store';
import { createResourceGuard } from '../guard';
import {
  applyGcPlan,
  buildGcPlan,
  type GcEvidence,
  type GcHooks,
  type GcJournal,
  type GcLeaseCoordinator,
  type ResourceSandboxIdentity,
} from '../gc';
import { createFakeFileTrust } from './file-trust-fixture';

const roots: string[] = [];
const guards: Array<Awaited<ReturnType<typeof createResourceGuard>>> = [];

afterEach(async () => {
  await Promise.all(guards.splice(0).map((guard) => guard.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-gc-repo-lease-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const sandboxRoot = join(workspaceRoot, '.resources');
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  const sandboxStat = await lstat(sandboxRoot);
  const sandbox: ResourceSandboxIdentity = {
    id: 'sandbox-1', root: sandboxRoot, generation: 'generation-1',
    dev: sandboxStat.dev, ino: sandboxStat.ino, uid: sandboxStat.uid,
  };
  const fileTrust = createFakeFileTrust();
  const guard = await createResourceGuard({
    sandboxRoot, workspaceRoot, repositoryRoots: [workspaceRoot],
    git: { async isTracked() { return false; } },
    fileTrust,
  });
  guards.push(guard);
  return { sandbox, sandboxRoot, guard, fileTrust };
}

async function evidence(sandbox: ResourceSandboxIdentity, path: string): Promise<GcEvidence> {
  const stat = await lstat(path);
  return {
    // `path` is a real filesystem path (`join`-built above), backslash-separated on win32 — a
    // hardcoded `/`-split here found nothing to split on and left the whole path as the "name".
    storageObjectId: `object-${basename(path)}`,
    path,
    sandboxId: sandbox.id,
    sandboxRoot: sandbox.root,
    sandboxGeneration: sandbox.generation,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    kind: stat.isDirectory() ? 'directory' : 'file',
    state: 'STALE',
    retention: 'ephemeral',
    referenceCount: 0,
    owned: true,
    lastUsedAt: '2020-01-01T00:00:00.000Z',
    logicalBytes: stat.size,
    allocatedBytes: stat.blocks * 512,
  };
}

function memoryCoordination() {
  const leases = new Set<string>();
  const lease: GcLeaseCoordinator = {
    async acquire(candidate) {
      const id = candidate.storageObjectId;
      if (leases.has(id)) return false;
      leases.add(id);
      return true;
    },
    async renew(candidate) { return leases.has(candidate.storageObjectId); },
    async release(id) { leases.delete(id); },
    async finalize() { return true; },
  };
  const journal: GcJournal = { async record() {} };
  return { lease, journal };
}

/**
 * A repository operation lease store that never expires and never questions liveness: this suite
 * only ever holds a lease for the duration of one synchronous hook call, so nothing here needs to
 * reason about time or dead holders — those are `operation-lease.test.ts`'s job. What it has to
 * get right is the one thing this suite is about: a second acquisition while the first is still
 * held is a conflict, and releasing frees it. That conflict is repository-wide — any live row of
 * the repository refuses, whichever operation holds it — which is what lets this suite prove a
 * `remove` cannot start underneath a running `gc --apply`.
 */
function createFakeRepositoryLeaseStore(): RepositoryOperationLeaseStore {
  const rows = new Map<string, RepositoryOperationLease>();
  const keyOf = (key: RepositoryOperationLeaseKey): string => `${key.repositoryId}\0${key.operation}`;
  const holderOf = (lease: RepositoryOperationLease): RepositoryOperationLeaseHolder => {
    const { token: _token, ...holder } = lease;
    return holder;
  };
  return {
    acquireRepositoryOperationLease(
      input: RepositoryOperationLeaseRequest,
      now: string,
    ): RepositoryOperationLeaseResult {
      const [existing] = [...rows.values()]
        .filter((row) => row.repositoryId === input.repositoryId)
        .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)
          || left.operation.localeCompare(right.operation));
      if (existing !== undefined) return { outcome: 'conflict', holder: holderOf(existing) };
      const lease: RepositoryOperationLease = {
        repositoryId: input.repositoryId,
        operation: input.operation,
        token: input.token,
        pid: input.pid,
        processStartTime: input.processStartTime,
        hostId: input.hostId,
        subjectWorktreeId: input.subjectWorktreeId ?? null,
        stage: null,
        acquiredAt: now,
        renewedAt: now,
        expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString(),
      };
      rows.set(keyOf(input), lease);
      return { outcome: 'acquired', lease, adoptedStage: null };
    },
    renewRepositoryOperationLease(key, token, now, ttlMs): boolean {
      const row = rows.get(keyOf(key));
      if (row === undefined || row.token !== token) return false;
      rows.set(keyOf(key), { ...row, renewedAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() });
      return true;
    },
    advanceRepositoryOperationLease(key, token, stage, now): boolean {
      const row = rows.get(keyOf(key));
      if (row === undefined || row.token !== token) return false;
      rows.set(keyOf(key), { ...row, stage, renewedAt: now });
      return true;
    },
    releaseRepositoryOperationLease(key, token): boolean {
      const row = rows.get(keyOf(key));
      if (row === undefined || row.token !== token) return false;
      rows.delete(keyOf(key));
      return true;
    },
    readRepositoryOperationLease(key): RepositoryOperationLeaseHolder | null {
      const row = rows.get(keyOf(key));
      return row === undefined ? null : holderOf(row);
    },
    listRepositoryOperationLeases(repositoryId): RepositoryOperationLeaseHolder[] {
      return [...rows.values()]
        .filter((row) => row.repositoryId === repositoryId)
        .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)
          || left.operation.localeCompare(right.operation))
        .map(holderOf);
    },
  };
}

const readProcessStartTime: ProcessStartTimeReader = async () => 'Mon Sep  1 09:00:00 2026';
const hostId = 'this-host';

describe('applyGcPlan repository-operation-lease wiring', () => {
  test('refuses a second "gc" on the same repository while the first apply is still running', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'absent');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-09-01T00:00:00.000Z' });
    // Already-absent, so the apply loop takes its shortest destructive branch and still calls
    // `beforeAbsentFinalize` from inside it — proving the repository lease is held for exactly the
    // window the task actually mutates state, not just around the outermost call.
    await rm(target);
    const coordination = memoryCoordination();
    const store = createFakeRepositoryLeaseStore();
    let contended: unknown = null;
    const hooks: GcHooks = {
      async beforeAbsentFinalize() {
        contended = await withRepositoryOperationLease(
          { store, readProcessStartTime, hostId, repositoryId: 'repository-1', operation: 'gc' },
          async () => 'a second gc should never reach this',
        ).then(() => null, (error: unknown) => error);
      },
    };

    const result = await applyGcPlan(plan, {
      guard, apply: true, lease: coordination.lease, journal: coordination.journal, hooks, fileTrust,
      repositoryLease: { store, readProcessStartTime, hostId, repositoryIds: ['repository-1'] },
    });

    expect(result.items[0]?.outcome, JSON.stringify(result.items[0])).toBe('already-absent');
    expect(contended).toBeInstanceOf(RepositoryOperationConflictError);
    const conflict = contended as RepositoryOperationConflictError;
    expect(conflict.code).toBe('WTM_OPERATION_CONFLICT');
    expect(conflict.context).toMatchObject({ repositoryId: 'repository-1', operation: 'gc' });
  });

  test('refuses the whole apply while a CLI remove holds the repository', async () => {
    // The cross-operation half of `todo.md` item 2, from `gc`'s side: `remove` and `gc` hold
    // different rows, so nothing in the schema stops a `gc --apply` from reclaiming a resource
    // the `remove` is halfway through releasing. The refusal is the widened conflict check.
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'stale');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-09-01T00:00:00.000Z' });
    const coordination = memoryCoordination();
    const store = createFakeRepositoryLeaseStore();

    const held = await withRepositoryOperationLease(
      { store, readProcessStartTime, hostId, repositoryId: 'repository-1', operation: 'remove' },
      async () => applyGcPlan(plan, {
        guard, apply: true, lease: coordination.lease, journal: coordination.journal, fileTrust,
        repositoryLease: { store, readProcessStartTime, hostId, repositoryIds: ['repository-1'] },
      }).then(() => null, (error: unknown) => error),
    );

    expect(held).toBeInstanceOf(RepositoryOperationConflictError);
    const conflict = held as RepositoryOperationConflictError;
    expect(conflict.code).toBe('WTM_OPERATION_CONFLICT');
    // `gc` was asked for; a `remove` is what is in the way, and the error says which is which.
    expect(conflict.context).toMatchObject({
      repositoryId: 'repository-1', operation: 'gc', holderOperation: 'remove',
    });
    // The apply never ran, so the file the plan was going to delete is still there.
    expect(existsSync(target)).toBe(true);
  });

  test('releases the repository lease once apply finishes, so the next gc can take it', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'absent');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-09-01T00:00:00.000Z' });
    await rm(target);
    const coordination = memoryCoordination();
    const store = createFakeRepositoryLeaseStore();

    await applyGcPlan(plan, {
      guard, apply: true, lease: coordination.lease, journal: coordination.journal, fileTrust,
      repositoryLease: { store, readProcessStartTime, hostId, repositoryIds: ['repository-1'] },
    });

    expect(store.readRepositoryOperationLease({ repositoryId: 'repository-1', operation: 'gc' })).toBeNull();
    const next = await withRepositoryOperationLease(
      { store, readProcessStartTime, hostId, repositoryId: 'repository-1', operation: 'gc' },
      async () => 'acquired',
    );
    expect(next).toBe('acquired');
  });

  test('a dry run never touches the repository lease store', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'stale');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-09-01T00:00:00.000Z' });
    const store = createFakeRepositoryLeaseStore();
    let readerCalls = 0;

    const result = await applyGcPlan(plan, {
      guard,
      fileTrust,
      repositoryLease: {
        store, readProcessStartTime: async (pid) => { readerCalls += 1; return readProcessStartTime(pid); },
        hostId,
        repositoryIds: ['repository-1'],
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.items).toEqual([{ storageObjectId: 'object-stale', path: target, outcome: 'would-delete' }]);
    expect(readerCalls).toBe(0);
    expect(store.readRepositoryOperationLease({ repositoryId: 'repository-1', operation: 'gc' })).toBeNull();
  });

  test('an empty repository list applies without ever acquiring a lease', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'stale');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-09-01T00:00:00.000Z' });
    const coordination = memoryCoordination();
    const store = createFakeRepositoryLeaseStore();

    const result = await applyGcPlan(plan, {
      guard, apply: true, lease: coordination.lease, journal: coordination.journal, fileTrust,
      repositoryLease: { store, readProcessStartTime, hostId, repositoryIds: [] },
    });

    expect(result.items[0]?.outcome, JSON.stringify(result.items[0])).toBe('deleted');
  });
});
