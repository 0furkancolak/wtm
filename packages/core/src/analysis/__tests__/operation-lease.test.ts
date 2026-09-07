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
  RepositoryOperation,
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
const myHostId = 'this-host';

/**
 * A faithful re-implementation of the store semantics this module depends on, so a unit test can
 * state a timeline instead of racing a wall clock: expiry is `expiresAt <= now` on ISO-8601 text,
 * `ownerLiveness` is consulted only for a colliding row that has already expired, and an
 * abandoned lease is reported rather than taken unless `adopt` is set.
 *
 * It holds one row *per operation*, keyed the way the real table is, because the semantics being
 * modelled are repository-wide: a `remove` collides with a live `gc` row, and a fake that could
 * only ever hold one row at a time would agree with that by accident — it would have nothing else
 * to hold — and would keep agreeing after a regression narrowed the real store back to a single
 * `(repository_id, operation)` lookup.
 */
class FakeLeaseStore implements RepositoryOperationLeaseStore {
  readonly rows = new Map<string, RepositoryOperationLease>();
  readonly livenessArguments: RepositoryOperationLeaseHolder[] = [];
  acquireCalls = 0;
  /** Runs at the top of an acquisition, to model a row that changes under the caller. */
  beforeAcquire: (() => void) | null = null;

  /** Puts a row in the table directly, so a test can state the state it wants to start from. */
  seed(lease: RepositoryOperationLease): void {
    this.rows.set(rowKey(lease), lease);
  }

  /** The row one operation holds, for a test that has to look at it rather than through it. */
  rowFor(operation: RepositoryOperation = 'remove'): RepositoryOperationLease | null {
    return this.rows.get(rowKey({ repositoryId, operation })) ?? null;
  }

  acquireRepositoryOperationLease(
    input: RepositoryOperationLeaseRequest,
    now: string,
  ): RepositoryOperationLeaseResult {
    this.acquireCalls += 1;
    this.beforeAcquire?.();
    // Every row of the repository, not just this operation's: exclusion is repository-wide.
    const reclaimable: RepositoryOperationLease[] = [];
    for (const existing of this.#repositoryRows(input.repositoryId)) {
      const holder = holderOf(existing);
      if (existing.expiresAt > now) return { outcome: 'conflict', holder };
      this.livenessArguments.push(holder);
      if ((input.ownerLiveness?.(holder) ?? 'gone') !== 'gone') return { outcome: 'conflict', holder };
      reclaimable.push(existing);
    }
    const [abandoned] = reclaimable;
    if (abandoned !== undefined) {
      if (input.adopt !== true) return { outcome: 'abandoned', holder: holderOf(abandoned) };
      // Adoption clears every dead row, or the sibling nobody adopted refuses the next caller.
      for (const dead of reclaimable) this.rows.delete(rowKey(dead));
    }
    // Only this operation's own dead row hands its journal on. Another operation's stage is not
    // this operation's progress.
    const resumed = reclaimable.find((dead) => dead.operation === input.operation);
    const stage = resumed?.stage ?? null;
    const lease: RepositoryOperationLease = {
      repositoryId: input.repositoryId,
      operation: input.operation,
      token: input.token,
      pid: input.pid,
      processStartTime: input.processStartTime,
      hostId: input.hostId,
      subjectWorktreeId: input.subjectWorktreeId ?? resumed?.subjectWorktreeId ?? null,
      stage,
      acquiredAt: now,
      renewedAt: now,
      expiresAt: new Date(Date.parse(now) + input.ttlMs).toISOString(),
    };
    this.rows.set(rowKey(lease), lease);
    return { outcome: 'acquired', lease, adoptedStage: stage };
  }

  renewRepositoryOperationLease(
    leaseKey: RepositoryOperationLeaseKey,
    token: string,
    now: string,
    ttlMs: number,
  ): boolean {
    const row = this.#matching(leaseKey);
    if (row === null || row.token !== token || row.expiresAt <= now) return false;
    this.rows.set(rowKey(row), { ...row, renewedAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() });
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
    this.rows.set(rowKey(row), { ...row, stage, renewedAt: now });
    return true;
  }

  releaseRepositoryOperationLease(leaseKey: RepositoryOperationLeaseKey, token: string): boolean {
    const row = this.#matching(leaseKey);
    if (row === null || row.token !== token) return false;
    this.rows.delete(rowKey(row));
    return true;
  }

  readRepositoryOperationLease(leaseKey: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null {
    const row = this.#matching(leaseKey);
    return row === null ? null : holderOf(row);
  }

  listRepositoryOperationLeases(id: string): RepositoryOperationLeaseHolder[] {
    return this.#repositoryRows(id).map(holderOf);
  }

  #matching(leaseKey: RepositoryOperationLeaseKey): RepositoryOperationLease | null {
    return this.rows.get(rowKey(leaseKey)) ?? null;
  }

  /** Oldest acquisition first, then by operation — the order the real table is read in. */
  #repositoryRows(id: string): RepositoryOperationLease[] {
    return [...this.rows.values()]
      .filter((row) => row.repositoryId === id)
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)
        || left.operation.localeCompare(right.operation));
  }
}

function rowKey(leaseKey: RepositoryOperationLeaseKey): string {
  return `${leaseKey.repositoryId}\u0000${leaseKey.operation}`;
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
  store.seed({
    repositoryId,
    operation: 'remove',
    token: 'holder-token',
    pid: holderPid,
    processStartTime: holderStartTime,
    hostId: myHostId,
    subjectWorktreeId: 'worktree-7',
    stage: null,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    renewedAt: '2026-08-31T10:14:02.118Z',
    expiresAt: '2026-08-31T10:16:02.118Z',
    ...overrides,
  });
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', subjectWorktreeId: 'worktree-7', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:15:00.000Z') },
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
    holderOperation: 'remove',
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
  expect(store.rowFor()?.token).toBe('holder-token');
});

test('reports an abandoned lease with the stage it stopped at and a --resume remediation', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'release-endpoints' });
  const reader = scriptedReader(new Map([[holderPid, null]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
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
    holderOperation: 'remove',
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async (session) => session.adoptedStage,
  );

  expect(resumedFrom).toBe('release-endpoints');
  expect(store.readRepositoryOperationLease(key)).toBeNull();
});

test('refuses a remove behind a live gc, and names the gc rather than blaming a second remove', async () => {
  // The `todo.md` item 2 case at the policy layer: two *different* destructive operations on one
  // repository. The rows are different rows -- nothing in the primary key keeps them apart -- so
  // the refusal has to come from the check, and it has to name what is actually in the way.
  const store = new FakeLeaseStore();
  seedHolder(store, { operation: 'gc', token: 'gc-token', stage: 'quarantine' });
  const reader = scriptedReader(new Map());
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:15:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict.code).toBe('WTM_OPERATION_CONFLICT');
  expect(conflict.abandoned).toBe(false);
  expect(conflict.context).toEqual({
    repositoryId,
    // What was asked for, and what is standing in its way. They are not the same operation, and
    // a message that reported only the request would tell the user a `remove` is running.
    operation: 'remove',
    holderOperation: 'gc',
    holderPid,
    acquiredAt: '2026-08-31T10:14:02.118Z',
    stage: null,
    abandoned: false,
  });
  expect(conflict.message).toContain('performing "gc"');
  expect(bodyRuns).toBe(0);
  // An unexpired holder is a conflict either way, so nothing was measured about it.
  expect(store.livenessArguments).toEqual([]);
  expect(reader.seen).toEqual([process.pid]);
  expect(store.rowFor('gc')?.token).toBe('gc-token');
});

test('measures a dead gc row when a remove is what is asking, instead of refusing it unseen', async () => {
  // The measurement happens outside the transaction and is matched back to the row it came from,
  // so a `remove` that only ever read its own row would hand the store no verdict for the `gc`
  // row it collides with -- and the store's conservative branch would refuse it as `alive`,
  // permanently, over a holder that has been dead for minutes.
  const store = new FakeLeaseStore();
  seedHolder(store, { operation: 'gc', token: 'gc-token', stage: 'quarantine' });
  const reader = scriptedReader(new Map([[holderPid, null]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => {
      bodyRuns += 1;
    },
  ).then(() => null, (error: unknown) => error);

  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict).toBeInstanceOf(RepositoryOperationConflictError);
  expect(conflict.abandoned).toBe(true);
  expect(conflict.context.holderOperation).toBe('gc');
  // Reported with the stage `gc` stopped at, but with no `wtm remove --resume` offered: resuming
  // is an offer to finish this command's own half-done work, and there is none.
  expect(conflict.context.stage).toBe('quarantine');
  expect(conflict.remediation).toEqual([]);
  expect(bodyRuns).toBe(0);
  // Measured once, from the other operation's row, on one attempt -- not retried as a race.
  expect(store.livenessArguments).toHaveLength(1);
  expect(store.livenessArguments[0]?.operation).toBe('gc');
  expect(store.acquireCalls).toBe(1);
});

test('clears a dead gc row out of an adopting remove\'s way without inheriting its journal', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, {
    operation: 'gc', token: 'gc-token', stage: 'quarantine', subjectWorktreeId: 'worktree-gc-was-on',
  });
  const reader = scriptedReader(new Map([[holderPid, null]]));

  const resumedFrom = await withRepositoryOperationLease(
    {
      store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId,
      operation: 'remove', subjectWorktreeId: 'worktree-7', adopt: true,
      now: clockAt('2026-08-31T10:17:00.000Z'),
    },
    async (session) => {
      // Inside the body: the `remove` holds the repository and the dead `gc` row is gone, so
      // nothing is left to refuse the next acquisition in this same run.
      expect(store.rowFor('gc')).toBeNull();
      expect(store.rowFor('remove')?.stage).toBeNull();
      expect(store.rowFor('remove')?.subjectWorktreeId).toBe('worktree-7');
      return session.adoptedStage;
    },
  );

  // Nothing was resumed. A cross-operation row being cleared is stale exclusivity, not progress.
  expect(resumedFrom).toBeNull();
  expect(store.rowFor('remove')).toBeNull();
});

test('refuses a remove behind a live gc even when this operation\'s own row is free', async () => {
  // Both rows present: a dead `remove` this caller could have adopted, and a live `gc` it cannot.
  // A check that looked at `remove` and stopped would adopt its own row and walk straight into
  // the running `gc`.
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes', expiresAt: '2026-08-31T10:15:00.000Z' });
  seedHolder(store, {
    operation: 'gc', token: 'gc-token', pid: 9_999, acquiredAt: '2026-08-31T10:16:00.000Z',
    renewedAt: '2026-08-31T10:16:00.000Z', expiresAt: '2026-08-31T10:18:00.000Z',
  });
  const reader = scriptedReader(new Map([[holderPid, null]]));

  const thrown = await withRepositoryOperationLease(
    {
      store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId,
      operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z'),
    },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  const conflict = thrown as RepositoryOperationConflictError;
  expect(conflict).toBeInstanceOf(RepositoryOperationConflictError);
  expect(conflict.abandoned).toBe(false);
  expect(conflict.context.holderOperation).toBe('gc');
  // The dead `remove` row is untouched: a refused acquisition adopts nothing.
  expect(store.rowFor('remove')?.token).toBe('holder-token');
  expect(store.rowFor('gc')?.token).toBe('gc-token');
});

test('refuses to adopt a lease whose holder is still alive, even past its expiry', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  const reader = scriptedReader(new Map([[holderPid, holderStartTime]]));
  let bodyRuns = 0;

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
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
  expect(store.rowFor()?.token).toBe('holder-token');
});

test('treats a holder whose start time no longer matches as gone, so a reused PID cannot hold a lease', async () => {
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes' });
  // The PID answers, but it is a different process wearing the dead holder's number.
  const reader = scriptedReader(new Map([[holderPid, 'Mon Aug 31 11:30:00 2026']]));

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).abandoned).toBe(true);

  const adopted = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async (session) => session.adoptedStage,
  );
  expect(adopted).toBe('stop-processes');
});

test('treats a holder on a different host as unknown, never abandoning or adopting its lease', async () => {
  // A network HOME shared by two hosts puts both platforms' identity strings in one state.db
  // (todo item 44). This reader would report the holder as gone if it were ever consulted for
  // its PID -- proving the refusal below comes from the host mismatch, not from a real check.
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes', hostId: 'other-host' });
  const reader = scriptedReader(new Map([[holderPid, null]]));

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).abandoned).toBe(false);
  // Only this process's own PID was ever put to the reader -- the holder's PID belongs to a
  // machine this reader cannot answer for, so the mismatch is caught before asking it anything.
  expect(reader.seen).toEqual([process.pid]);

  const adoptAttempt = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);
  expect(adoptAttempt).toBeInstanceOf(RepositoryOperationConflictError);
  expect((adoptAttempt as RepositoryOperationConflictError).abandoned).toBe(false);
  // The other host's row is untouched: still there, still under its own token.
  expect(store.rowFor()?.token).toBe('holder-token');
});

test('treats a lease acquired before host identity existed the same as a different host, never this one', async () => {
  // Decision for todo item 44's "how are pre-migration rows interpreted": an empty host_id can
  // never equal a real one, so a legacy row reads as `unknown` -- exactly as safe as, and no more
  // privileged than, a row genuinely written by another host.
  const store = new FakeLeaseStore();
  seedHolder(store, { stage: 'stop-processes', hostId: '' });
  const reader = scriptedReader(new Map([[holderPid, null]]));

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:17:00.000Z') },
    async () => 'unreachable',
  ).then(() => null, (error: unknown) => error);

  expect(thrown).toBeInstanceOf(RepositoryOperationConflictError);
  expect((thrown as RepositoryOperationConflictError).abandoned).toBe(false);
  expect(reader.seen).toEqual([process.pid]);
});

test('records a stage on the lease row while the session is open', async () => {
  const store = new FakeLeaseStore();
  const reader = scriptedReader(new Map());
  const stagesSeenInside: Array<string | null> = [];
  const failure = new Error('verification found residue');

  const thrown = await withRepositoryOperationLease(
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
    { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', now: clockAt('2026-08-31T10:00:00.000Z') },
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
      { store, readProcessStartTime: reader.read, hostId: myHostId, repositoryId, operation: 'remove', adopt: true, now: clockAt('2026-08-31T10:17:00.000Z') },
      async () => 'unreachable',
    ).then(() => null, (error: unknown) => error);

    expect(`pid ${String(pid)}: ${String(thrown instanceof TypeError)}`).toBe(`pid ${String(pid)}: true`);
    expect((thrown as TypeError).message).toContain(String(pid));
    // Only our own PID was ever put to the reader; the bad one was rejected in front of it.
    expect(reader.seen.slice(measured)).toEqual([process.pid]);
    expect(store.rowFor()?.token).toBe('holder-token');
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
