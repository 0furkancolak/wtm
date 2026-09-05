import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createResourceGuard } from '../guard';
import {
  applyGcPlan,
  buildGcPlan,
  recoverGcJournalEntry,
  type GcEvidence,
  type GcHooks,
  type GcJournal,
  type GcLeaseCoordinator,
  type ResourceSandboxIdentity,
} from '../gc';
import { createFakeFileTrust } from './file-trust-fixture';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wtm-gc-'));
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
  return { root, workspaceRoot, sandboxRoot, sandbox, guard, fileTrust };
}

async function evidence(
  sandbox: ResourceSandboxIdentity,
  path: string,
  overrides: Partial<GcEvidence> = {},
): Promise<GcEvidence> {
  const stat = await lstat(path);
  return {
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
    ...overrides,
  };
}

function memoryCoordination() {
  const leases = new Set<string>();
  const phases: string[] = [];
  const entries: Parameters<GcJournal['record']>[0][] = [];
  const lease: GcLeaseCoordinator = {
    async acquire(candidate) {
      const id = candidate.storageObjectId;
      if (leases.has(id)) return false;
      leases.add(id);
      return true;
    },
    async renew(candidate) { return leases.has(candidate.storageObjectId); },
    async release(id) { leases.delete(id); },
    async finalize(entry) {
      phases.push(entry.phase);
      entries.push(entry);
      return true;
    },
  };
  const journal: GcJournal = {
    async record(entry) { phases.push(entry.phase); entries.push(entry); },
  };
  return { lease, journal, phases, leases, entries };
}

describe('safe resource GC', () => {
  test('marks only owned zero-reference stale ephemeral objects; age is secondary', async () => {
    const { sandbox, sandboxRoot } = await fixture();
    const names = ['eligible', 'live', 'unknown', 'persistent', 'young'];
    for (const name of names) await writeFile(join(sandboxRoot, name), name);
    const records = [
      await evidence(sandbox, join(sandboxRoot, 'eligible')),
      await evidence(sandbox, join(sandboxRoot, 'live'), { referenceCount: 1 }),
      await evidence(sandbox, join(sandboxRoot, 'unknown'), { owned: false }),
      await evidence(sandbox, join(sandboxRoot, 'persistent'), { retention: 'persistent' }),
      await evidence(sandbox, join(sandboxRoot, 'young'), { lastUsedAt: '2026-08-28T00:00:00.000Z' }),
    ];
    const plan = buildGcPlan({
      sandbox, records, now: '2026-08-28T01:00:00.000Z', minimumAgeMs: 86_400_000,
    });
    expect(plan.candidates.map((item) => item.storageObjectId)).toEqual(['object-eligible']);
    expect(plan.excluded.map((item) => item.reason)).toEqual([
      'live-reference', 'persistent', 'unknown-ownership', 'minimum-age',
    ]);
  });

  test('defaults to dry-run, performs identical guards, and writes no lease/journal/filesystem state', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'stale');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const result = await applyGcPlan(plan, { guard, fileTrust, lease: coordination.lease, journal: coordination.journal });
    expect(result.dryRun).toBe(true);
    expect(result.items).toEqual([{ storageObjectId: 'object-stale', path: target, outcome: 'would-delete' }]);
    expect(await readFile(target, 'utf8')).toBe('stale');
    expect(coordination.phases).toEqual([]);
    expect(coordination.leases.size).toBe(0);
  });

  test('quarantines exact identity, journals every phase, and repeated apply is idempotent', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, 'data'), 'data');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const first = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
    });
    expect(first.items[0]?.outcome).toBe('deleted');
    expect(coordination.phases).toEqual(['prepared', 'prepared', 'quarantined', 'deleting', 'deleted', 'finalized']);
    expect(await lstat(target).catch(() => null)).toBeNull();

    const second = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
    });
    expect(second.items[0]?.outcome).toBe('already-absent');
  });

  test('leases and finalizes an already-absent apply candidate instead of leaving stale state', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'absent');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    await rm(target);
    const coordination = memoryCoordination();
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
    });
    expect(result.items[0]?.outcome).toBe('already-absent');
    expect(coordination.phases).toEqual(['prepared', 'finalized']);
  });

  test('rechecks an absent candidate immediately before finalization and preserves a late occupant', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'absent-race');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    await rm(target);
    const coordination = memoryCoordination();
    const hooks = {
      async beforeAbsentFinalize() { await writeFile(target, 'winner', { flag: 'wx' }); },
    } as GcHooks & { beforeAbsentFinalize(): Promise<void> };
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal, hooks,
    });
    expect(result.items[0]).toMatchObject({ outcome: 'failed', phase: 'prepared' });
    expect(await readFile(target, 'utf8')).toBe('winner');
    expect(coordination.phases).toEqual(['prepared']);
  });

  test('replays prepared absent finalization before an impossible removed-object lease acquisition', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'prepared-absent-crash');
    await writeFile(target, 'old');
    const candidate = await evidence(sandbox, target);
    await rm(target);
    const coordination = memoryCoordination();
    let acquireCalls = 0;
    coordination.lease.acquire = async () => {
      acquireCalls += 1;
      return false;
    };
    const entry: Parameters<typeof recoverGcJournalEntry>[0] = {
      operationId: 'prepared-absent-operation',
      storageObjectId: candidate.storageObjectId,
      phase: 'prepared',
      originalPath: target,
      quarantinePath: null,
      dev: candidate.dev,
      ino: candidate.ino,
      uid: candidate.uid,
      sandboxId: candidate.sandboxId,
      sandboxGeneration: candidate.sandboxGeneration,
      kind: candidate.kind,
      quarantineContainer: null,
    };

    const recovered = await recoverGcJournalEntry(entry, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(recovered.outcome, JSON.stringify(recovered)).toBe('already-absent');
    expect(acquireCalls).toBe(0);
    expect(coordination.phases).toEqual(['finalized']);
  });

  test('fails before quarantine when the exact cleanup reservation cannot be renewed', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'expired');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    coordination.lease.renew = async () => false;
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
    });
    expect(result.items[0]).toMatchObject({ outcome: 'failed', phase: 'prepared' });
    expect(await readFile(target, 'utf8')).toBe('old');
  });

  test('preserves an original-path replacement created after quarantine', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterQuarantine() { await writeFile(target, 'replacement', { flag: 'wx' }); } },
    });
    expect(await readFile(target, 'utf8')).toBe('replacement');
  });

  test('fails closed on a quarantine race and preserves structured recovery evidence', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: {
        async beforeQuarantine() {
          await rm(target);
          await writeFile(target, 'raced');
        },
      },
    });
    expect(result.items[0]).toMatchObject({
      outcome: 'failed',
      phase: 'prepared',
      // Naming the message pins which check refused. `assertCandidateIdentity`'s tuple comparison
      // refuses this on APFS and accepts it on ext4, so a test that asserted only the outcome
      // would have gone on passing here while the GC deleted the replacement on Linux.
      error: { message: 'The GC candidate was replaced after it was validated.' },
    });
    expect(await readFile(target, 'utf8')).toBe('raced');
  });

  test.each(['file', 'directory', 'symlink'] as const)(
    'preserves a foreign %s winner created at the exact quarantine path before the final move',
    async (winnerKind) => {
      const { root, sandbox, sandboxRoot, guard, fileTrust } = await fixture();
      const target = join(sandboxRoot, 'winner-race');
      await writeFile(target, 'owned');
      const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
      const coordination = memoryCoordination();
      let winnerPath = '';
      const result = await applyGcPlan(plan, {
        guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
        hooks: {
          async beforeQuarantine() {
            winnerPath = coordination.entries.at(-1)?.quarantinePath ?? '';
            if (winnerKind === 'file') await writeFile(winnerPath, 'foreign', { flag: 'wx' });
            else if (winnerKind === 'directory') await mkdir(winnerPath);
            else await symlink(join(root, 'foreign-target'), winnerPath);
          },
        },
      });
      expect(result.items[0]?.outcome).toBe('failed');
      expect(await readFile(target, 'utf8')).toBe('owned');
      const winner = await lstat(winnerPath);
      expect(winnerKind === 'file' ? await readFile(winnerPath, 'utf8') : winner.isDirectory() || winner.isSymbolicLink())
        .toBe(winnerKind === 'file' ? 'foreign' : true);
    },
  );

  test('recovers a crash-left exact quarantine without touching a replacement original', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'stale');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const interrupted = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterQuarantine() { throw new Error('simulated crash'); } },
    });
    const quarantinePath = interrupted.items[0] && 'quarantinePath' in interrupted.items[0]
      ? interrupted.items[0].quarantinePath
      : undefined;
    expect(quarantinePath).toBeString();
    await writeFile(target, 'replacement', { flag: 'wx' });
    const entry = coordination.entries.findLast((item) => item.phase === 'quarantined');
    expect(entry).toBeDefined();
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered.outcome, JSON.stringify(recovered)).toBe('deleted');
    expect(await readFile(target, 'utf8')).toBe('replacement');
    expect(await lstat(quarantinePath as string).catch(() => null)).toBeNull();
    expect(await lstat(dirname(quarantinePath as string)).catch(() => null)).toBeNull();
  });

  test('recovers an exact two-link file quarantine after crashing before original unlink', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'link-prefix-crash');
    await writeFile(target, 'owned');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const hooks = {
      async afterFileLink() { throw new Error('crash after link'); },
    } as GcHooks & { afterFileLink(): Promise<void> };
    const interrupted = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal, hooks,
    });
    expect(interrupted.items[0]).toMatchObject({ outcome: 'failed', phase: 'linked' });
    const entry = coordination.entries.findLast((item) => item.phase === 'linked');
    expect(entry).toBeDefined();
    const quarantinePath = entry?.quarantinePath as string;
    const [original, quarantine] = await Promise.all([lstat(target), lstat(quarantinePath)]);
    expect({ same: original.dev === quarantine.dev && original.ino === quarantine.ino, links: original.nlink })
      .toEqual({ same: true, links: 2 });
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered.outcome, JSON.stringify(recovered)).toBe('deleted');
    expect(await lstat(target).catch(() => null)).toBeNull();
    expect(await lstat(dirname(quarantinePath)).catch(() => null)).toBeNull();
  });

  test('recovers only an explicitly unlinking file topology after crashing after original unlink', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'post-unlink-crash');
    await writeFile(target, 'owned');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterFileUnlink() { throw new Error('crash after exact original unlink'); } },
    });
    expect(result.items[0]).toMatchObject({ outcome: 'failed', phase: 'unlinking' });
    const entry = coordination.entries.findLast((item) => item.phase === 'unlinking');
    const quarantinePath = entry?.quarantinePath as string;
    expect(await lstat(target).catch(() => null)).toBeNull();
    expect((await lstat(quarantinePath)).nlink).toBe(1);
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered.outcome).toBe('deleted');
    expect(await lstat(quarantinePath).catch(() => null)).toBeNull();
  });

  test('fails closed on missing or extra links in a linked recovery topology', async () => {
    for (const topology of ['missing-original', 'extra-link'] as const) {
      const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
      const target = join(sandboxRoot, `linked-${topology}`);
      await writeFile(target, 'owned');
      const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
      const coordination = memoryCoordination();
      const hooks = {
        async afterFileLink(_candidate: GcEvidence, quarantinePath: string) {
          if (topology === 'missing-original') await rm(target);
          else await link(target, join(sandboxRoot, 'third-link'));
          throw new Error('crash with invalid topology');
        },
      } as GcHooks & { afterFileLink(candidate: GcEvidence, quarantinePath: string): Promise<void> };
      await applyGcPlan(plan, { guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal, hooks });
      const entry = coordination.entries.findLast((item) => item.phase === 'linked');
      const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
        guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
      });
      expect(recovered).toMatchObject({ outcome: 'failed', phase: 'linked' });
    }
  });

  test('resumes a prepared empty container and removes only its exact recorded inode', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'prepared-container');
    await writeFile(target, 'owned');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterContainerCreated() { throw new Error('crash after container'); } },
    });
    const entry = coordination.entries.findLast((item) => item.phase === 'prepared' && item.quarantineContainer !== null);
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered.outcome).toBe('deleted');
    expect(await lstat(entry?.quarantineContainer?.path as string).catch(() => null)).toBeNull();
  });

  test('preserves a swapped quarantine container and retries a crash during exact finalized cleanup', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const swappedTarget = join(sandboxRoot, 'swapped-container');
    await writeFile(swappedTarget, 'owned');
    const swappedPlan = buildGcPlan({ sandbox, records: [await evidence(sandbox, swappedTarget)], now: '2026-08-28T01:00:00.000Z' });
    const swappedCoordination = memoryCoordination();
    await applyGcPlan(swappedPlan, {
      guard, fileTrust, apply: true, lease: swappedCoordination.lease, journal: swappedCoordination.journal,
      hooks: { async afterQuarantine() { throw new Error('crash after quarantine'); } },
    });
    const swappedEntry = swappedCoordination.entries.findLast((item) => item.phase === 'quarantined');
    const containerPath = swappedEntry?.quarantineContainer?.path as string;
    const movedContainer = `${containerPath}-owned`;
    await rename(containerPath, movedContainer);
    await mkdir(containerPath, { mode: 0o700 });
    const swappedRecovery = await recoverGcJournalEntry(swappedEntry as NonNullable<typeof swappedEntry>, {
      guard, fileTrust, lease: swappedCoordination.lease, journal: swappedCoordination.journal,
    });
    expect(swappedRecovery.outcome).toBe('failed');
    expect(await lstat(containerPath)).toBeDefined();
    expect(await lstat(movedContainer)).toBeDefined();

    const target = join(sandboxRoot, 'cleanup-crash');
    await writeFile(target, 'owned');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async beforeContainerCleanup() { throw new Error('crash during cleanup'); } },
    });
    const finalized = coordination.entries.findLast((item) => item.phase === 'finalized');
    const firstRecovery = await recoverGcJournalEntry(finalized as NonNullable<typeof finalized>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
      hooks: { async beforeContainerCleanup() { throw new Error('repeat cleanup crash'); } },
    });
    expect(firstRecovery.outcome).toBe('failed');
    expect(await lstat(finalized?.quarantineContainer?.path as string)).toBeDefined();
    const secondRecovery = await recoverGcJournalEntry(finalized as NonNullable<typeof finalized>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(secondRecovery.outcome).toBe('already-absent');
    expect(await lstat(finalized?.quarantineContainer?.path as string).catch(() => null)).toBeNull();
    const repeatedRecovery = await recoverGcJournalEntry(finalized as NonNullable<typeof finalized>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(repeatedRecovery.outcome).toBe('already-absent');
  });

  test('cleans a finalized recorded container when the original path holds an unrelated replacement', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'finalized-replacement');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const interrupted = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: {
        async afterQuarantine() { await writeFile(target, 'replacement', { flag: 'wx' }); },
        async beforeContainerCleanup() { throw new Error('crash after atomic finalization'); },
      },
    });
    expect(interrupted.items[0]).toMatchObject({ outcome: 'failed', phase: 'finalized' });
    const finalized = coordination.entries.findLast((item) => item.phase === 'finalized');
    expect(finalized).toBeDefined();
    expect(await readFile(target, 'utf8')).toBe('replacement');
    expect(await lstat(finalized?.quarantineContainer?.path as string)).toBeDefined();

    const recovered = await recoverGcJournalEntry(finalized as NonNullable<typeof finalized>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(recovered.outcome, JSON.stringify(recovered)).toBe('already-absent');
    expect(await readFile(target, 'utf8')).toBe('replacement');
    expect(await lstat(finalized?.quarantineContainer?.path as string).catch(() => null)).toBeNull();

    const repeatedRecovery = await recoverGcJournalEntry(finalized as NonNullable<typeof finalized>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(repeatedRecovery.outcome, JSON.stringify(repeatedRecovery)).toBe('already-absent');
    expect(await readFile(target, 'utf8')).toBe('replacement');
  });

  test('stops recursive apply deletion before the next mutation when lease renewal is lost', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'slow-tree');
    await mkdir(target);
    for (let index = 0; index < 8; index += 1) await writeFile(join(target, `${index}.txt`), String(index));
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    let renewals = 0;
    coordination.lease.renew = async () => ++renewals < 3;
    const result = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
    });
    expect(result.items[0]).toMatchObject({ outcome: 'failed', phase: 'deleting' });
    const quarantinePath = coordination.entries.findLast((entry) => entry.phase === 'deleting')?.quarantinePath as string;
    expect((await readdir(quarantinePath)).length).toBe(8);
  });

  test('renews during recovery deletion and leaves exact quarantine evidence when ownership is lost', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'recovery-heartbeat');
    await mkdir(target);
    for (let index = 0; index < 4; index += 1) await writeFile(join(target, `${index}.txt`), String(index));
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterQuarantine() { throw new Error('crash before delete'); } },
    });
    const entry = coordination.entries.findLast((item) => item.phase === 'quarantined');
    coordination.lease.renew = async () => false;
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered).toMatchObject({ outcome: 'failed', phase: 'deleting' });
    expect(await lstat(entry?.quarantinePath as string)).toBeDefined();
  });

  test('recovers the all-absent legacy deleting prefix without recorded container identity', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'legacy-deleting-crash');
    await writeFile(target, 'old');
    const candidate = await evidence(sandbox, target);
    const quarantinePath = join(sandboxRoot, '.wtm-gc-legacy-deleting', 'object');
    await rm(target);
    const coordination = memoryCoordination();
    const entry: Parameters<typeof recoverGcJournalEntry>[0] = {
      operationId: 'legacy-deleting-operation',
      storageObjectId: candidate.storageObjectId,
      phase: 'deleting',
      originalPath: target,
      quarantinePath,
      dev: candidate.dev,
      ino: candidate.ino,
      uid: candidate.uid,
      sandboxId: candidate.sandboxId,
      sandboxGeneration: candidate.sandboxGeneration,
      kind: candidate.kind,
      quarantineContainer: null,
    };

    const recovered = await recoverGcJournalEntry(entry, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(recovered.outcome, JSON.stringify(recovered)).toBe('deleted');
    expect(coordination.phases).toEqual(['deleted', 'finalized']);
  });

  test('rejects legacy deleting replay outside the quarantine trust boundary', async () => {
    const { root, sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'unsafe-legacy-deleting-crash');
    await writeFile(target, 'old');
    const candidate = await evidence(sandbox, target);
    await rm(target);
    const coordination = memoryCoordination();
    const entry: Parameters<typeof recoverGcJournalEntry>[0] = {
      operationId: 'unsafe-legacy-deleting-operation',
      storageObjectId: candidate.storageObjectId,
      phase: 'deleting',
      originalPath: target,
      quarantinePath: join(root, 'foreign-quarantine', 'object'),
      dev: candidate.dev,
      ino: candidate.ino,
      uid: candidate.uid,
      sandboxId: candidate.sandboxId,
      sandboxGeneration: candidate.sandboxGeneration,
      kind: candidate.kind,
      quarantineContainer: null,
    };

    const recovered = await recoverGcJournalEntry(entry, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(recovered).toMatchObject({
      outcome: 'failed',
      phase: 'deleting',
      error: { code: 'RESOURCE_PATH_DENIED' },
    });
    expect(coordination.phases).toEqual([]);
  });

  test('rejects all-absent deleting evidence with a modern recorded container identity', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'modern-deleting-crash');
    await writeFile(target, 'old');
    const candidate = await evidence(sandbox, target);
    const containerPath = join(sandboxRoot, '.wtm-gc-modern-deleting');
    const quarantinePath = join(containerPath, 'object');
    await mkdir(containerPath, { mode: 0o700 });
    const container = await lstat(containerPath);
    await rm(target);
    await rm(containerPath, { recursive: true });
    const coordination = memoryCoordination();
    const entry: Parameters<typeof recoverGcJournalEntry>[0] = {
      operationId: 'modern-deleting-operation',
      storageObjectId: candidate.storageObjectId,
      phase: 'deleting',
      originalPath: target,
      quarantinePath,
      dev: candidate.dev,
      ino: candidate.ino,
      uid: candidate.uid,
      sandboxId: candidate.sandboxId,
      sandboxGeneration: candidate.sandboxGeneration,
      kind: candidate.kind,
      quarantineContainer: {
        path: containerPath,
        dev: container.dev,
        ino: container.ino,
        uid: container.uid,
        mode: container.mode,
      },
    };

    const recovered = await recoverGcJournalEntry(entry, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });

    expect(recovered).toMatchObject({ outcome: 'failed', phase: 'deleting' });
    expect(coordination.phases).toEqual([]);
  });

  test('finalizes an exact quarantined journal when deletion completed before the deleted phase was recorded', async () => {
    const { sandbox, sandboxRoot, guard, fileTrust } = await fixture();
    const target = join(sandboxRoot, 'delete-crash');
    await writeFile(target, 'old');
    const plan = buildGcPlan({ sandbox, records: [await evidence(sandbox, target)], now: '2026-08-28T01:00:00.000Z' });
    const coordination = memoryCoordination();
    const interrupted = await applyGcPlan(plan, {
      guard, fileTrust, apply: true, lease: coordination.lease, journal: coordination.journal,
      hooks: { async afterQuarantine() { throw new Error('crash before delete'); } },
    });
    const quarantinePath = interrupted.items[0] && 'quarantinePath' in interrupted.items[0]
      ? interrupted.items[0].quarantinePath
      : undefined;
    const entry = coordination.entries.findLast((item) => item.phase === 'quarantined');
    await rm(quarantinePath as string);
    const recovered = await recoverGcJournalEntry(entry as NonNullable<typeof entry>, {
      guard, fileTrust, lease: coordination.lease, journal: coordination.journal,
    });
    expect(recovered.outcome).toBe('deleted');
    expect(coordination.phases.slice(-2)).toEqual(['deleted', 'finalized']);
  });
});
