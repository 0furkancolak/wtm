import { afterEach, expect, test } from 'bun:test';
import { access } from 'node:fs/promises';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import {
  RepositoryOperationConflictError,
  type ProcessStartTimeReader,
  type RepositoryOperationLeaseStore,
} from '../operation-lease';
import {
  removalStages,
  removeWorktreeGuarded,
  type EndpointReleaseReport,
  type EphemeralCleanupReport,
  type ManagedProcessResidue,
  type RemovalRuntimeCoordinator,
  type RemovalSubject,
  type StoppedProcessesReport,
} from '../remove-worktree';
import type {
  RepositoryOperationLease,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseRequest,
  RepositoryOperationLeaseResult,
} from '../../state/store';

const repositoryId = 'repository-1';
const worktreeId = 'worktree-7';
const selfStartTime = 'Mon Aug 31 09:59:00 2026';
const deadHolderPid = 4_242;

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

interface CoordinatorScript {
  reclaimable?: readonly string[];
  stopped?: number;
  stopError?: Error;
  residue?: ManagedProcessResidue;
  onCleanup?: (subject: RemovalSubject) => Promise<void>;
  collected?: number;
  retained?: { name: string; reason: string }[];
  released?: number;
}

/**
 * Records the name of every stage it is asked to perform together with whether the worktree was
 * still on disk at that moment, so a test can assert the *order* of the lifecycle rather than the
 * mere membership of its calls — including where `git worktree remove` falls inside it.
 */
class RecordingCoordinator implements RemovalRuntimeCoordinator {
  readonly calls: string[] = [];
  readonly subjects: RemovalSubject[] = [];

  constructor(private readonly script: CoordinatorScript = {}) {}

  async reclaimablePaths(subject: RemovalSubject): Promise<readonly string[]> {
    await this.#record('reclaimablePaths', subject);
    return this.script.reclaimable ?? [];
  }

  async stopManagedProcesses(subject: RemovalSubject): Promise<StoppedProcessesReport> {
    await this.#record('stopManagedProcesses', subject);
    if (this.script.stopError !== undefined) throw this.script.stopError;
    return { stopped: this.script.stopped ?? 0 };
  }

  async verifyManagedProcessesStopped(subject: RemovalSubject): Promise<ManagedProcessResidue> {
    await this.#record('verifyManagedProcessesStopped', subject);
    return this.script.residue ?? { active: 0, cleanupOwed: 0 };
  }

  async cleanupEphemeralResources(subject: RemovalSubject): Promise<EphemeralCleanupReport> {
    await this.#record('cleanupEphemeralResources', subject);
    await this.script.onCleanup?.(subject);
    return { collected: this.script.collected ?? 0, retained: this.script.retained ?? [] };
  }

  async releaseEndpointLeases(subject: RemovalSubject): Promise<EndpointReleaseReport> {
    await this.#record('releaseEndpointLeases', subject);
    return { released: this.script.released ?? 0 };
  }

  async reconcile(subject: RemovalSubject): Promise<void> {
    await this.#record('reconcile', subject);
  }

  async #record(name: string, subject: RemovalSubject): Promise<void> {
    this.subjects.push(subject);
    this.calls.push(`${name}:${(await pathExists(subject.worktreePath)) ? 'present' : 'gone'}`);
  }
}

/**
 * The four lease semantics this lifecycle depends on, re-implemented in memory so a test can seed
 * a holder instead of racing a wall clock. Expiry is `expiresAt <= now` on ISO-8601 text and
 * `ownerLiveness` is consulted only for a colliding row that has already expired, exactly as the
 * SQLite store behaves.
 */
class FakeLeaseStore implements RepositoryOperationLeaseStore {
  row: RepositoryOperationLease | null = null;
  readonly stages: string[] = [];
  releases = 0;

  acquireRepositoryOperationLease(
    input: RepositoryOperationLeaseRequest,
    now: string,
  ): RepositoryOperationLeaseResult {
    const existing = this.#matching(input);
    if (existing !== null) {
      const holder = holderOf(existing);
      if (existing.expiresAt > now) return { outcome: 'conflict', holder };
      if ((input.ownerLiveness?.(holder) ?? 'gone') === 'alive') return { outcome: 'conflict', holder };
      if (input.adopt !== true) return { outcome: 'abandoned', holder };
    }
    const stage = existing?.stage ?? null;
    const lease: RepositoryOperationLease = {
      repositoryId: input.repositoryId,
      operation: input.operation,
      token: input.token,
      pid: input.pid,
      processStartTime: input.processStartTime,
      subjectWorktreeId: input.subjectWorktreeId ?? existing?.subjectWorktreeId ?? null,
      stage,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString(),
    };
    this.row = lease;
    return { outcome: 'acquired', lease, adoptedStage: existing === null ? null : stage };
  }

  renewRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    now: string,
    ttlMs: number,
  ): boolean {
    const row = this.#matching(key);
    if (row === null || row.token !== token || row.expiresAt <= now) return false;
    this.row = { ...row, renewedAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
    return true;
  }

  advanceRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    stage: string,
    now: string,
  ): boolean {
    const row = this.#matching(key);
    if (row === null || row.token !== token) return false;
    this.stages.push(stage);
    this.row = { ...row, stage, renewedAt: now };
    return true;
  }

  releaseRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string): boolean {
    const row = this.#matching(key);
    if (row === null || row.token !== token) return false;
    this.releases += 1;
    this.row = null;
    return true;
  }

  readRepositoryOperationLease(key: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null {
    const row = this.#matching(key);
    return row === null ? null : holderOf(row);
  }

  #matching(key: RepositoryOperationLeaseKey): RepositoryOperationLease | null {
    const row = this.row;
    if (row === null) return null;
    return row.repositoryId === key.repositoryId && row.operation === key.operation ? row : null;
  }
}

test('runs every removal stage in the documented order and deletes the worktree last', async () => {
  const fixture = await createFixture();
  const coordinator = new RecordingCoordinator({ stopped: 2, collected: 1, released: 2 });

  const result = await removeWorktreeGuarded({ context: context(fixture), coordinator });

  expect(coordinator.calls).toEqual([
    'stopManagedProcesses:present',
    'verifyManagedProcessesStopped:present',
    'cleanupEphemeralResources:present',
    'releaseEndpointLeases:present',
    // Only reconcile sees the worktree gone: every runtime stage ran while the directory was
    // still there, and Git deleted it after the endpoints were released.
    'reconcile:gone',
  ]);
  expect(coordinator.subjects[0]).toEqual({
    repositoryId,
    worktreeId,
    worktreePath: fixture.linkedWorktreePath,
  });
  expect(result.analysis.identity.path).toBe(fixture.linkedWorktreePath);
  expect(result.cleanup).toEqual({
    stoppedProcesses: 2,
    releasedEndpoints: 2,
    collectedResources: 1,
    retainedResources: [],
  });
  expect(result.resumedFrom).toBeNull();
  expect(result.deferredBlockers).toEqual([]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
});

test('refuses in front of the runtime when an untracked file is not the coordinator\'s to reclaim', async () => {
  const fixture = await createFixture();
  await fixture.write(fixture.linkedWorktreePath, 'scratch.md', 'notes worth keeping\n');
  const coordinator = new RecordingCoordinator();

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_UNTRACKED', context: { paths: ['scratch.md'] } }],
  });
  // The point of the first gate: a worktree holding real work is refused before a single process
  // is stopped or a single directory deleted. Asking what is reclaimable is the only thing that
  // happened, and it is a read.
  expect(coordinator.calls).toEqual(['reclaimablePaths:present']);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('refuses when one blocker names a reclaimable path and a real file together', async () => {
  const fixture = await createFixture();
  await fixture.write(fixture.linkedWorktreePath, 'node_modules/.package-lock.json', '{}\n');
  await fixture.write(fixture.linkedWorktreePath, 'scratch.md', 'notes worth keeping\n');
  const coordinator = new RecordingCoordinator({
    reclaimable: [`${fixture.linkedWorktreePath}/node_modules`],
  });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  // Git raises one `GIT_UNTRACKED` blocker for every untracked path at once, so deferring it
  // partially would delete `scratch.md` on the strength of `node_modules`. A blocker is deferred
  // whole or not at all.
  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_UNTRACKED', context: { paths: ['node_modules/.package-lock.json', 'scratch.md'] } }],
  });
  expect(coordinator.calls).toEqual(['reclaimablePaths:present']);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('never defers a blocker that is not about untracked content', async () => {
  const fixture = await createFixture();
  await fixture.write(fixture.linkedWorktreePath, 'node_modules/.package-lock.json', '{}\n');
  await fixture.write(fixture.linkedWorktreePath, 'feature.txt', 'edited, committed, never pushed\n');
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-am', 'Local-only commit']);
  const coordinator = new RecordingCoordinator({
    reclaimable: [`${fixture.linkedWorktreePath}/node_modules`],
  });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  // The untracked blocker is reclaimable and steps aside; the unpushed commit is not, and no
  // amount of reclaimable content makes it so. Cleanup cannot give a commit back.
  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_HEAD_NOT_REMOTE_PERSISTED' }],
  });
  expect(coordinator.calls).toEqual(['reclaimablePaths:present']);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('never defers a dirty tracked file that happens to sit inside a reclaimable path', async () => {
  const fixture = await createFixture();
  await fixture.write(fixture.linkedWorktreePath, 'build/checked-in.txt', 'tracked, and inside the target\n');
  await fixture.git(fixture.linkedWorktreePath, ['add', 'build/checked-in.txt']);
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Track a file under build/']);
  await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
  await fixture.write(fixture.linkedWorktreePath, 'build/checked-in.txt', 'edited, not committed\n');
  const coordinator = new RecordingCoordinator({
    reclaimable: [`${fixture.linkedWorktreePath}/build`],
  });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  // Every dirty-path blocker names paths the same way an untracked one does, so containment alone
  // would happily defer this edit — and the deletion it authorizes is of work Git could not give
  // back. Only `GIT_UNTRACKED` is ever deferrable; the code is the check, not the paths.
  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_DIRTY_UNSTAGED', context: { paths: ['build/checked-in.txt'] } }],
  });
  expect(coordinator.calls).toEqual([]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('refuses at the second gate when the cleanup stage retains what it deferred', async () => {
  const fixture = await createFixture();
  await fixture.write(fixture.linkedWorktreePath, 'node_modules/.package-lock.json', '{}\n');
  const coordinator = new RecordingCoordinator({
    reclaimable: [`${fixture.linkedWorktreePath}/node_modules`],
    retained: [{ name: 'node_modules', reason: 'shared' }],
  });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  // Deferring is not a waiver. The directory is still there at the re-analysis, so the removal
  // refuses there — which is what keeps a coordinator that over-promises from costing a file.
  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_UNTRACKED' }],
  });
  expect(coordinator.calls).toEqual([
    'reclaimablePaths:present',
    'stopManagedProcesses:present',
    'verifyManagedProcessesStopped:present',
    'cleanupEphemeralResources:present',
    'releaseEndpointLeases:present',
  ]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('records every stage through the lease in the documented order', async () => {
  const fixture = await createFixture();
  const store = new FakeLeaseStore();
  const readProcessStartTime = scriptedReader(new Map());

  await removeWorktreeGuarded({
    context: context(fixture),
    coordinator: new RecordingCoordinator(),
    lease: { store, readProcessStartTime, repositoryId },
  });

  expect(store.stages).toEqual([...removalStages]);
});

test('leaves the worktree on disk and in the topology when stopping its processes fails', async () => {
  const fixture = await createFixture();
  const coordinator = new RecordingCoordinator({ stopError: new Error('daemon refused to stop task dev') });

  await expect(removeWorktreeGuarded({ context: context(fixture), coordinator }))
    .rejects.toThrow('daemon refused to stop task dev');

  expect(coordinator.calls).toEqual(['stopManagedProcesses:present']);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  const topology = await fixture.git(fixture.repoPath, ['worktree', 'list', '--porcelain']);
  expect(topology.stdout).toContain(fixture.linkedWorktreePath);
});

test('refuses to remove a worktree whose managed process records are still active', async () => {
  const fixture = await createFixture();
  const coordinator = new RecordingCoordinator({ residue: { active: 1, cleanupOwed: 2 } });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(Error);
  const failure = thrown as Error & { code?: string; context?: Record<string, unknown> };
  expect(failure.message).toContain('1');
  expect(failure.message).toContain('2');
  expect(failure.context).toMatchObject({ active: 1, cleanupOwed: 2, worktreeId });
  expect(coordinator.calls).toEqual([
    'stopManagedProcesses:present',
    'verifyManagedProcessesStopped:present',
  ]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('blocks removal when cleanup writes an untracked file into the worktree', async () => {
  const fixture = await createFixture();
  const coordinator = new RecordingCoordinator({
    async onCleanup(subject) {
      await fixture.write(subject.worktreePath, 'dev-server.log', 'listening on 4173\n');
    },
  });

  const thrown = await removeWorktreeGuarded({ context: context(fixture), coordinator })
    .then(() => null, (error: unknown) => error);

  expect(thrown).toMatchObject({
    name: 'WorktreeRemovalBlockedError',
    blockers: [{ code: 'GIT_UNTRACKED' }],
  });
  // The stages before the second analysis all ran; the removal stopped at the re-analysis.
  expect(coordinator.calls).toEqual([
    'stopManagedProcesses:present',
    'verifyManagedProcessesStopped:present',
    'cleanupEphemeralResources:present',
    'releaseEndpointLeases:present',
  ]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
});

test('carries the resources the coordinator retained through into the result', async () => {
  const fixture = await createFixture();
  const retained = [
    { name: 'node_modules', reason: 'shared' },
    { name: '.venv', reason: 'persistent' },
  ];

  const result = await removeWorktreeGuarded({
    context: context(fixture),
    coordinator: new RecordingCoordinator({ collected: 3, retained, released: 1, stopped: 1 }),
  });

  expect(result.cleanup.retainedResources).toEqual(retained);
  expect(result.cleanup.collectedResources).toBe(3);
});

test('resumes an abandoned lease from the stage it stopped at and completes the removal', async () => {
  const fixture = await createFixture();
  const store = new FakeLeaseStore();
  seedHolder(store, {
    stage: 'release-endpoints',
    expiresAt: '2026-08-31T10:16:02.118Z',
  });
  const readProcessStartTime = scriptedReader(new Map([[deadHolderPid, null]]));
  const coordinator = new RecordingCoordinator();

  const result = await removeWorktreeGuarded({
    context: context(fixture),
    coordinator,
    lease: { store, readProcessStartTime, repositoryId, adopt: true },
  });

  expect(result.resumedFrom).toBe('release-endpoints');
  // Every stage is idempotent, so a resumed removal re-runs the ones the dead process claimed.
  expect(coordinator.calls).toEqual([
    'stopManagedProcesses:present',
    'verifyManagedProcessesStopped:present',
    'cleanupEphemeralResources:present',
    'releaseEndpointLeases:present',
    'reconcile:gone',
  ]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(false);
  expect(store.row).toBeNull();
});

test('refuses to remove behind a live holder of the repository lease', async () => {
  const fixture = await createFixture();
  const store = new FakeLeaseStore();
  seedHolder(store, { expiresAt: '2099-01-01T00:00:00.000Z' });
  const readProcessStartTime = scriptedReader(new Map([[deadHolderPid, null]]));
  const coordinator = new RecordingCoordinator();

  const thrown = await removeWorktreeGuarded({
    context: context(fixture),
    coordinator,
    lease: { store, readProcessStartTime, repositoryId },
  }).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).code).toBe('WTM_OPERATION_CONFLICT');
  expect(coordinator.calls).toEqual([]);
  expect(await pathExists(fixture.linkedWorktreePath)).toBe(true);
  expect(store.row?.pid).toBe(deadHolderPid);
});

test('releases the repository lease after a successful removal and after a failed one', async () => {
  const failed = await createFixture();
  const failingStore = new FakeLeaseStore();
  const readProcessStartTime = scriptedReader(new Map());

  await expect(removeWorktreeGuarded({
    context: context(failed),
    coordinator: new RecordingCoordinator({ stopError: new Error('daemon unreachable') }),
    lease: { store: failingStore, readProcessStartTime, repositoryId },
  })).rejects.toThrow('daemon unreachable');
  expect(failingStore.row).toBeNull();
  expect(failingStore.releases).toBe(1);

  const succeeded = await createFixture();
  const store = new FakeLeaseStore();
  await removeWorktreeGuarded({
    context: context(succeeded),
    coordinator: new RecordingCoordinator(),
    lease: { store, readProcessStartTime, repositoryId },
  });
  expect(store.row).toBeNull();
  expect(store.releases).toBe(1);
});

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

function context(fixture: GitSafetyFixture) {
  return {
    repoPath: fixture.repoPath,
    worktreePath: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
    repositoryId,
    worktreeId,
  };
}

function holderOf(lease: RepositoryOperationLease): RepositoryOperationLeaseHolder {
  const { token: _token, ...holder } = lease;
  return holder;
}

function seedHolder(store: FakeLeaseStore, overrides: Partial<RepositoryOperationLease> = {}): void {
  store.row = {
    repositoryId,
    operation: 'remove',
    token: 'holder-token',
    pid: deadHolderPid,
    processStartTime: 'Mon Aug 31 10:00:00 2026',
    subjectWorktreeId: worktreeId,
    stage: null,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    renewedAt: '2026-08-31T10:14:02.118Z',
    expiresAt: '2026-08-31T10:16:02.118Z',
    ...overrides,
  };
}

/**
 * Answers for our own process so the lease's own-identity check passes; scripts everything else.
 *
 * The lease takes this as an argument rather than reading an installed global, so a test that
 * forgets to clean up cannot change what the next one measures.
 */
function scriptedReader(answers: ReadonlyMap<number, string | null>): ProcessStartTimeReader {
  return async (pid) => {
    if (pid === process.pid) return selfStartTime;
    return answers.get(pid) ?? null;
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
