import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';
import {
  defaultOperationLeaseTtlMs,
  RepositoryOperationConflictError,
  withRepositoryOperationLease,
  type ProcessStartTimeReader,
  type RepositoryOperationLeaseStore,
} from '../operation-lease';
import type {
  RepositoryOperationLease,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseRequest,
  RepositoryOperationLeaseResult,
} from '../../state/store';

const repositoryId = 'repository-1';
const key: RepositoryOperationLeaseKey = { repositoryId, operation: 'remove' };
const selfStartTime = 'Mon Aug 31 09:59:00 2026';
const holderPid = 4_242;
const holderStartTime = 'Mon Aug 31 10:00:00 2026';

/**
 * A faithful re-implementation of the four store semantics this module depends on, so a unit
 * test can state a timeline instead of racing a wall clock: expiry is `expiresAt <= now` on
 * ISO-8601 text, `ownerLiveness` is consulted only for a colliding row that has already
 * expired, and an abandoned lease is reported rather than taken unless `adopt` is set.
 */
class FakeLeaseStore implements RepositoryOperationLeaseStore {
  row: RepositoryOperationLease | null = null;
  readonly livenessArguments: RepositoryOperationLeaseHolder[] = [];
  acquireCalls = 0;
  /** Runs at the top of an acquisition, to model a row that changes under the caller. */
  beforeAcquire: (() => void) | null = null;

  acquireRepositoryOperationLease(
    input: RepositoryOperationLeaseRequest,
    now: string,
  ): RepositoryOperationLeaseResult {
    this.acquireCalls += 1;
    this.beforeAcquire?.();
    const existing = this.#matching(input);
    if (existing !== null) {
      const holder = holderOf(existing);
      if (existing.expiresAt > now) return { outcome: 'conflict', holder };
      this.livenessArguments.push(holder);
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
    leaseKey: RepositoryOperationLeaseKey,
    token: string,
    now: string,
    ttlMs: number,
  ): boolean {
    const row = this.#matching(leaseKey);
    if (row === null || row.token !== token || row.expiresAt <= now) return false;
    this.row = { ...row, renewedAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
    return true;
  }

  advanceRepositoryOperationLease(
    leaseKey: RepositoryOperationLeaseKey,
    token: string,
    stage: string,
    now: string,
  ): boolean {
    const row = this.#matching(leaseKey);
    if (row === null || row.token !== token) return false;
    this.row = { ...row, stage, renewedAt: now };
    return true;
  }

  releaseRepositoryOperationLease(leaseKey: RepositoryOperationLeaseKey, token: string): boolean {
    const row = this.#matching(leaseKey);
    if (row === null || row.token !== token) return false;
    this.row = null;
    return true;
  }

  readRepositoryOperationLease(leaseKey: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null {
    const row = this.#matching(leaseKey);
    return row === null ? null : holderOf(row);
  }

  #matching(leaseKey: RepositoryOperationLeaseKey): RepositoryOperationLease | null {
    const row = this.row;
    if (row === null) return null;
    return row.repositoryId === leaseKey.repositoryId && row.operation === leaseKey.operation ? row : null;
  }
}

function holderOf(lease: RepositoryOperationLease): RepositoryOperationLeaseHolder {
  const { token: _token, ...holder } = lease;
  return holder;
}

/** A clock the test states, so expiry is a fact of the fixture rather than of the machine. */
function clockAt(instant: string): () => string {
  return () => instant;
}

function seedHolder(store: FakeLeaseStore, overrides: Partial<RepositoryOperationLease> = {}): void {
  store.row = {
    repositoryId,
    operation: 'remove',
    token: 'holder-token',
    pid: holderPid,
    processStartTime: holderStartTime,
    subjectWorktreeId: 'worktree-7',
    stage: null,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    renewedAt: '2026-08-31T10:14:02.118Z',
    expiresAt: '2026-08-31T10:16:02.118Z',
    ...overrides,
  };
}

interface ScriptedReader {
  read: ProcessStartTimeReader;
  /** Every PID whose start time was measured, in order. */
  seen: number[];
}

/**
 * The start-time reader a test hands to the lease. It answers for our own process so the module's
 * own-identity check can pass, and scripts everything else from `answers`.
 *
 * It is passed in rather than installed. The module-global seam this replaced had to be restored
 * in an `afterEach`, which is a restoration that can be forgotten — and forgetting it left the
 * *next* test measuring whatever the previous one scripted. A reader that only exists as an
 * argument cannot leak into a test that did not ask for it.
 */
function scriptedReader(answers: ReadonlyMap<number, string | null>): ScriptedReader {
  const seen: number[] = [];
  return {
    seen,
    read: async (pid) => {
      seen.push(pid);
      if (pid === process.pid) return selfStartTime;
      return answers.get(pid) ?? null;
    },
  };
}

test('runs the body, returns its value, and releases the lease afterwards', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  const observedTokens: string[] = [];

  const result = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', subjectWorktreeId: 'worktree-7', now: clockAt('2026-08-31T10:00:00.000Z') },
    async (session) => {
      observedTokens.push(session.token);
      expect(session.adoptedStage).toBeNull();
      expect(store.readRepositoryOperationLease(key)?.pid).toBe(process.pid);
      return 'removed';
    },
  );

  expect(result).toBe('removed');
  expect(observedTokens).toHaveLength(1);
  expect(observedTokens[0]).not.toBe('');
  expect(store.readRepositoryOperationLease(key)).toBeNull();
  expect(reader.seen).toEqual([process.pid]);
});

test('gives the lease a default two-minute time to live', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  let expiresAt = '';

  await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async () => {
      expiresAt = store.readRepositoryOperationLease(key)?.expiresAt ?? '';
    },
  );

  expect(defaultOperationLeaseTtlMs).toBe(120_000);
  expect(expiresAt).toBe('2026-08-31T10:02:00.000Z');
});

test('releases the lease when the body throws and rethrows that very error', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  const failure = new Error('cleanup could not finish');

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async () => {
      throw failure;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBe(failure);
  expect(store.readRepositoryOperationLease(key)).toBeNull();
});

test('refuses to start behind a live holder, without measuring anything about it', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store);
  const reader = scriptedReader(new Map([[holderPid, holderStartTime]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:15:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict.code).toBe('WTM_OPERATION_CONFLICT');
  expect(conflict.severity).toBe('error');
  expect(conflict.abandoned).toBe(false);
  expect(conflict.context).toEqual({
    repositoryId,
    operation: 'remove',
    holderPid,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    stage: null,
    abandoned: false,
  });
  expect(conflict.remediation).toEqual([]);
  expect(bodyRuns).toBe(0);
  expect(store.livenessArguments).toEqual([]);
  expect(reader.seen).toEqual([process.pid]);
  // The holder view carries no token, so the untouched row is checked directly.
  expect(store.row?.token).toBe('holder-token');
});

test('reports an abandoned lease with the stage it stopped at and a --resume remediation', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'release-endpoints' });
  const reader = scriptedReader(new Map([[holderPid, null]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict.abandoned).toBe(true);
  expect(conflict.context).toEqual({
    repositoryId,
    operation: 'remove',
    holderPid,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    stage: 'release-endpoints',
    abandoned: true,
  });
  expect(conflict.remediation).toEqual([{ kind: 'command-suggestion', argv: ['wtm', 'remove', '--resume'] }]);
  expect(conflict.message).toContain('release-endpoints');
  expect(bodyRuns).toBe(0);
  expect(store.livenessArguments).toHaveLength(1);
  // A lease abandoned by a dead holder keeps its journal, which is what makes it resumable.
  expect(store.readRepositoryOperationLease(key)?.stage).toBe('release-endpoints');
});

test('adopts an abandoned lease and reports the stage it resumed from', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'release-endpoints' });
  const reader = scriptedReader(new Map([[holderPid, null]]));

  const resumedFrom = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async (session) => session.adoptedStage,
  );

  expect(resumedFrom).toBe('release-endpoints');
  expect(store.readRepositoryOperationLease(key)).toBeNull();
});

test('refuses to adopt a lease whose holder is still alive, even past its expiry', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  const reader = scriptedReader(new Map([[holderPid, holderStartTime]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict.abandoned).toBe(false);
  // A live holder's stage is a moving target, so the refusal never quotes one.
  expect(conflict.context.stage).toBeNull();
  expect(conflict.remediation).toEqual([]);
  expect(bodyRuns).toBe(0);
  // The holder view carries no token, so the untouched row is checked directly.
  expect(store.row?.token).toBe('holder-token');
});

test('treats a holder whose start time no longer matches as gone, so a reused PID cannot hold a lease', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  // The PID answers, but it is a different process wearing the dead holder's number.
  const reader = scriptedReader(new Map([[holderPid, 'Mon Aug 31 11:30:00 2026']]));

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).abandoned).toBe(true);

  const adopted = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async (session) => session.adoptedStage,
  );
  expect(adopted).toBe('stop-processes');
});

test('records a stage on the lease row while the session is open', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  const stagesSeenInside: Array<string | null> = [];
  const failure = new Error('verification found residue');

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async (session) => {
      session.advance('stop-processes');
      stagesSeenInside.push(store.readRepositoryOperationLease(key)?.stage ?? null);
      session.advance('release-endpoints');
      stagesSeenInside.push(store.readRepositoryOperationLease(key)?.stage ?? null);
      throw failure;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBe(failure);
  expect(stagesSeenInside).toEqual(['stop-processes', 'release-endpoints']);
  // The body threw, so this process released what it still owned; the journal that survives a
  // crash is the one a *dead* holder leaves behind, which the abandoned-lease tests cover.
  expect(store.readRepositoryOperationLease(key)).toBeNull();
});

test('refuses to record a stage once the lease is no longer held', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  let advanceFailure: unknown = null;

  await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async (session) => {
      store.releaseRepositoryOperationLease(key, session.token);
      try {
        session.advance('git-remove');
      } catch (error) {
        advanceFailure = error;
      }
    },
  );

  expect(advanceFailure).toBeInstanceOf(Error);
  expect((advanceFailure as Error).message).toContain('remove');
});

test('never measures a holder when nothing collides', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());

  await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async () => undefined,
  );

  expect(store.livenessArguments).toEqual([]);
  expect(store.acquireCalls).toBe(1);
  expect(reader.seen).toEqual([process.pid]);
});

test('never evicts a holder it has not measured, and retries the whole measurement once', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  const reader = scriptedReader(new Map([[holderPid, null], [4_243, null]]));
  // The row is replaced by a different dead holder exactly once, after the first measurement.
  store.beforeAcquire = () => {
    store.beforeAcquire = null;
    seedHolder(store, { stage: 'cleanup-resources', pid: 4_243, token: 'successor-token' });
  };

  const resumedFrom = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async (session) => session.adoptedStage,
  );

  expect(resumedFrom).toBe('cleanup-resources');
  expect(store.acquireCalls).toBe(2);
  // Both attempts collided with the successor row; only the second one had measured it.
  expect(store.livenessArguments.map((holder) => holder.pid)).toEqual([4_243, 4_243]);
  expect(reader.seen).toEqual([process.pid, holderPid, 4_243]);
});

test('reports a conflict rather than looping when the holder keeps changing under the measurement', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  const reader = scriptedReader(new Map());
  let generation = 0;
  store.beforeAcquire = () => {
    generation += 1;
    seedHolder(store, { stage: 'stop-processes', acquiredAt: `2026-08-31T10:1${String(generation)}:00.000Z` });
  };
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).abandoned).toBe(false);
  expect(store.acquireCalls).toBe(2);
  expect(bodyRuns).toBe(0);
});

test('refuses to take a lease when this process has no readable start identity', async () => {
  const store = new FakeLeaseStore();
  // A reader that answers "no such process" for every PID, this process included.
  const reader: ScriptedReader = { read: async () => null, seen: [] };

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(String(process.pid));
  expect(store.acquireCalls).toBe(0);
});

test('treats an empty start time as no identity, rather than as an identity that is empty', async () => {
  const store = new FakeLeaseStore();
  // A reader is allowed to answer with an empty string; two of them would compare equal, so an
  // empty answer has to mean "not identified" and not "identified as nothing".
  const reader: ScriptedReader = { read: async () => '', seen: [] };

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain('no readable start identity');
  expect(store.acquireCalls).toBe(0);
});

test('refuses a lease row whose PID is not a positive integer instead of measuring it', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());

  // A stored PID is only as trustworthy as the row it came from. Handing a nonsense one to the
  // reader would get an absence back — and an absence reads as "the holder is gone, take the
  // lease", which is the one conclusion this module may never reach by accident.
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    seedHolder(store, { pid, expiresAt: '2026-08-31T10:16:02.118Z' });
    const measured = reader.seen.length;

    const thrown = await withRepositoryOperationLease(
      { store, readProcessStartTime: reader.read, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
      async () => 'unreachable',
    ).then(() => null, (error: unknown) => error);

    expect(`pid ${String(pid)}: ${String(thrown instanceof TypeError)}`).toBe(`pid ${String(pid)}: true`);
    expect((thrown as TypeError).message).toContain(String(pid));
    // Only our own PID was ever put to the reader; the bad one was rejected in front of it.
    expect(reader.seen.slice(measured)).toEqual([process.pid]);
    expect(store.row?.token).toBe('holder-token');
  }
});

const scenarioPath = fileURLToPath(new URL('./operation-lease.scenario.ts', import.meta.url));

test('takes, journals, releases, refuses and adopts a lease in a real SQLite state store', () => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath, 'sqlite-operation-lease']);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout) as Record<string, unknown>).toEqual({
    bodySawOwnLease: true,
    bodyResult: 'removed',
    stageDuringBody: 'release-endpoints',
    leaseAfterSuccess: null,
    liveHolderCode: 'WTM_OPERATION_CONFLICT',
    liveHolderAbandoned: false,
    liveHolderStage: null,
    abandonedCode: 'WTM_OPERATION_CONFLICT',
    abandonedAbandoned: true,
    abandonedStage: 'stop-processes',
    abandonedRemediation: [{ kind: 'command-suggestion', argv: ['wtm', 'remove', '--resume'] }],
    resumedFrom: 'stop-processes',
    leaseAfterResume: null,
  });
});
