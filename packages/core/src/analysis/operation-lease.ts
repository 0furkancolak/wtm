/**
 * Cross-process serialization for the destructive repository operations.
 *
 * The store owns the lock; this module owns the *policy* around it — who this process is, whether
 * a colliding holder is still alive, and what a caller is told when it is refused. The split
 * exists because the two questions have incompatible shapes: the store's `ownerLiveness` verdict
 * is consulted synchronously inside `BEGIN IMMEDIATE`, while learning a PID's start time means
 * asking the operating system, which is asynchronous. So liveness is measured *before* the
 * transaction and handed in as a precomputed verdict, with a guard that refuses to apply that
 * verdict to any row other than the one it was measured from.
 *
 * How the start time is read is the caller's business, not this module's. Core states the question
 * as {@link ProcessStartTimeReader} and every caller supplies an implementation, which is what
 * keeps `@wtm/core` free of any operating system: the CLI and the daemon are the composition roots
 * that choose one. This replaced a module-global `installProcessStartIdentityReader` seam in the
 * increment that made platforms explicit — a global any test may install is a global a test may
 * forget to restore, and the reader that decides whether somebody else's lease may be reclaimed is
 * the last thing that should be ambient.
 *
 * There is deliberately no renewal heartbeat. A lapsed TTL never evicts a live holder — the store
 * asks for a liveness verdict before it reclaims anything — so an operation that outruns its TTL
 * is already safe, and a timer would add a moving part (and a second failure mode: the timer that
 * stops firing under load) that prevents no failure the design has.
 */
import { randomUUID } from 'node:crypto';
import type { Remediation } from '@wtm/protocol';
import type {
  RepositoryOperation,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseResult,
  StateStore,
} from '../state/store';

/**
 * Answers "when did the process at this PID start?", and `null` only when there is no such
 * process.
 *
 * A reader that cannot answer for any *other* reason must reject rather than resolve `null`,
 * because a wrong `null` releases somebody else's lease — which is the one failure this whole
 * mechanism exists to prevent. `@wtm/platform` supplies the implementations; core deliberately
 * knows nothing about how the question is asked, only that it is asked.
 */
export type ProcessStartTimeReader = (pid: number) => Promise<string | null>;

/**
 * A PID alone does not identify a process: the kernel reuses PIDs, so a lease left behind by a
 * dead `wtm` can look alive the moment an unrelated process inherits its number. Pairing the PID
 * with the start time the kernel recorded for it makes the pair unique in practice, which is what
 * the comparisons below rely on.
 *
 * This is deliberately narrower than the daemon's four-field process identity: a lease owner is a
 * `wtm` process, not a supervised task, so no pgid and no command fingerprint are needed.
 */
export interface ProcessStartIdentity {
  pid: number;
  processStartTime: string;
}

/**
 * Two minutes. Long enough that no honest stage of a removal reaches it, short enough that the
 * lease of a crashed process is recoverable within one impatient re-run.
 */
export const defaultOperationLeaseTtlMs = 120_000;

/**
 * How many times the acquisition re-measures a holder that changed under it. One retry, then a
 * refusal: a repository whose lease row keeps changing has a live participant, and a destructive
 * operation that spins waiting for it is worse than one that says so.
 */
const maxAcquisitionAttempts = 2;

/**
 * The narrow store surface a lease needs, so a caller can pass a fake without building a
 * `StateStore`.
 */
export type RepositoryOperationLeaseStore = Pick<
  StateStore,
  | 'acquireRepositoryOperationLease'
  | 'renewRepositoryOperationLease'
  | 'advanceRepositoryOperationLease'
  | 'releaseRepositoryOperationLease'
  | 'readRepositoryOperationLease'
  | 'listRepositoryOperationLeases'
>;

export interface RepositoryOperationSession {
  /** The capability that owns the lease. Only this token may journal or release it. */
  readonly token: string;
  /** The stage an adopted lease had reached, and null when the lease was taken fresh. */
  readonly adoptedStage: string | null;
  /** Records the last completed stage, so an interrupted operation can be resumed from it. */
  advance(stage: string): void;
}

export interface RepositoryOperationLeaseInput {
  store: RepositoryOperationLeaseStore;
  /**
   * How this caller learns a PID's start time. Required, and deliberately not defaulted: a lease
   * is the mechanism that keeps two destructive operations out of one repository, and a default
   * reader would be a platform assumption made silently, in core, by whichever caller forgot.
   */
  readProcessStartTime: ProcessStartTimeReader;
  /**
   * Which machine this process is running on. Required and not defaulted for the same reason
   * `readProcessStartTime` is: a lease that cannot name its own host cannot be told apart from
   * one on a different host sharing this state store over a network `HOME` (todo item 44), and a
   * default supplied silently by core would be a platform assumption made in the one package
   * that must not make one.
   */
  hostId: string;
  repositoryId: string;
  operation: RepositoryOperation;
  subjectWorktreeId?: string | undefined;
  /** Takes over a lease abandoned by a dead holder. This is the `--resume` path. */
  adopt?: boolean | undefined;
  ttlMs?: number | undefined;
  now?: (() => string) | undefined;
}

export interface RepositoryOperationConflictDetail {
  abandoned: boolean;
  context: Record<string, unknown>;
  remediation: readonly Remediation[];
}

export class RepositoryOperationConflictError extends Error {
  readonly code = 'WTM_OPERATION_CONFLICT' as const;
  readonly severity = 'error' as const;
  /** True when the holder is provably gone and its half-done work is adoptable. */
  readonly abandoned: boolean;
  readonly context: Record<string, unknown>;
  readonly remediation: readonly Remediation[];

  constructor(message: string, detail: RepositoryOperationConflictDetail) {
    super(message);
    this.name = 'RepositoryOperationConflictError';
    this.abandoned = detail.abandoned;
    this.context = Object.freeze({ ...detail.context });
    this.remediation = Object.freeze([...detail.remediation]);
  }
}

/**
 * Holds the repository for one destructive operation while `body` runs, and releases it however
 * `body` ends. A colliding operation is a refusal, never a wait: a destructive command that queues
 * for an unbounded time behind another one is harder to reason about than one that names the
 * process it is waiting for.
 */
export async function withRepositoryOperationLease<T>(
  input: RepositoryOperationLeaseInput,
  body: (session: RepositoryOperationSession) => Promise<T>,
): Promise<T> {
  const now = input.now ?? (() => new Date().toISOString());
  const key: RepositoryOperationLeaseKey = { repositoryId: input.repositoryId, operation: input.operation };
  const owner = await readProcessStartIdentity(input.readProcessStartTime, process.pid);
  if (owner === null) {
    // Our own live process must have a readable start time. If it does not, nothing here can
    // distinguish this process from a recycled PID, and no lease taken in this environment could
    // be trusted by whoever finds it later.
    throw new Error(
      `This process (pid ${String(process.pid)}) has no readable start identity, so it cannot own a repository operation lease.`,
    );
  }
  const token = randomUUID();
  const adoptedStage = await acquireLease(input, key, owner, token, now);
  const session: RepositoryOperationSession = {
    token,
    adoptedStage,
    advance(stage: string): void {
      // Journalling through the lease row is what makes the stage and the lock incapable of
      // disagreeing: losing the lease and losing the journal are the same event.
      if (!input.store.advanceRepositoryOperationLease(key, token, stage, now())) {
        throw new Error(
          `The "${input.operation}" lease on repository ${input.repositoryId} is no longer held, so the stage "${stage}" was not recorded.`,
        );
      }
    },
  };
  try {
    return await body(session);
  } finally {
    // A false return means the lease was already gone (adopted, or released inside the body).
    // Nothing is owed to a lock this process no longer holds, and raising here would replace the
    // body's own failure with a less informative one.
    input.store.releaseRepositoryOperationLease(key, token);
  }
}

async function acquireLease(
  input: RepositoryOperationLeaseInput,
  key: RepositoryOperationLeaseKey,
  owner: ProcessStartIdentity,
  token: string,
  now: () => string,
): Promise<string | null> {
  const ttlMs = input.ttlMs ?? defaultOperationLeaseTtlMs;
  let refusal: RepositoryOperationLeaseResult | null = null;
  for (let attempt = 0; attempt < maxAcquisitionAttempts; attempt += 1) {
    const timestamp = now();
    // Every operation's row, not just this one's: the store refuses on any colliding row of the
    // repository, so a verdict measured only for `key.operation` would leave a dead `gc` row
    // permanently unanswerable — refused as `alive` on the conservative branch below, forever,
    // by a `remove` that could safely have cleared it.
    const observed = input.store.listRepositoryOperationLeases(key.repositoryId);
    // Liveness is only ever the deciding question for a row that has already expired, and it
    // costs a trip to the operating system, so an unexpired holder is left unmeasured — it is a
    // conflict either way.
    const measured: Array<{ holder: RepositoryOperationLeaseHolder; verdict: 'alive' | 'unknown' | 'gone' }> = [];
    for (const holder of observed) {
      if (holder.expiresAt > timestamp) continue;
      measured.push({ holder, verdict: await livenessOf(input.readProcessStartTime, holder, input.hostId) });
    }
    let raced = false;
    const result = input.store.acquireRepositoryOperationLease({
      repositoryId: key.repositoryId,
      operation: key.operation,
      token,
      pid: owner.pid,
      processStartTime: owner.processStartTime,
      hostId: input.hostId,
      subjectWorktreeId: input.subjectWorktreeId,
      ttlMs,
      adopt: input.adopt,
      ownerLiveness: (holder) => {
        const match = measured.find((entry) => isSameHolder(entry.holder, holder));
        if (match === undefined) {
          // The row inside the transaction is not a row whose owner was measured, so no verdict
          // in hand says anything about this holder. `alive` is the conservative answer: it can
          // only cost a retry, while `gone` would evict a process whose liveness was never
          // actually checked — and two processes inside one destruction is the failure this
          // whole mechanism exists to prevent.
          raced = true;
          return 'alive';
        }
        return match.verdict;
      },
    }, timestamp);
    if (result.outcome === 'acquired') return result.adoptedStage;
    refusal = result;
    if (!raced) break;
  }
  throw conflictFrom(key, refusal);
}

/**
 * A holder is gone when its PID has no process, and equally when the process at that PID started
 * at a different time — that second case is a recycled PID wearing a dead holder's number.
 *
 * Neither question is askable of a holder on a different host: this process's own operating
 * system has no way to inspect a PID on a machine it is not running on, and a coincidentally
 * present or absent local PID would answer a question about the wrong computer. A host mismatch
 * — including a holder recorded before `hostId` existed, whose empty string can never equal a
 * real one — resolves `unknown` before either read is attempted.
 */
async function livenessOf(
  read: ProcessStartTimeReader,
  holder: RepositoryOperationLeaseHolder,
  myHostId: string,
): Promise<'alive' | 'unknown' | 'gone'> {
  if (holder.hostId !== myHostId) return 'unknown';
  const identity = await readProcessStartIdentity(read, holder.pid);
  if (identity === null) return 'gone';
  return identity.processStartTime === holder.processStartTime ? 'alive' : 'gone';
}

/**
 * Resolves `null` when the process is absent, and only then. The PID is validated before the
 * reader ever sees it: a nonsense PID is a caller's bug, and letting it through would turn into an
 * absence — which reads as "the holder is gone, reclaim the lease".
 *
 * An empty start time is treated as absence for the same reason it always was: a reader that
 * answers with nothing has not identified a process, and the identity would compare equal to the
 * next empty one.
 */
async function readProcessStartIdentity(
  read: ProcessStartTimeReader,
  pid: number,
): Promise<ProcessStartIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new TypeError(`A process identity needs a positive integer PID, received ${String(pid)}`);
  }
  const processStartTime = await read(pid);
  if (processStartTime === null || processStartTime.length === 0) return null;
  return { pid, processStartTime };
}

/**
 * The fields that make a holder the same holder: which row it is, who owns it, and when the
 * lease was taken.
 *
 * The operation is part of the identity now that one repository's rows are measured together.
 * One process can hold two of them, taken in the same millisecond by the same PID, and matching
 * the wrong one would apply a verdict measured from one row to a different row's owner.
 */
function isSameHolder(
  measured: RepositoryOperationLeaseHolder,
  observed: RepositoryOperationLeaseHolder,
): boolean {
  return measured.operation === observed.operation
    && measured.pid === observed.pid
    && measured.processStartTime === observed.processStartTime
    && measured.hostId === observed.hostId
    && measured.acquiredAt === observed.acquiredAt;
}

function conflictFrom(
  key: RepositoryOperationLeaseKey,
  refusal: RepositoryOperationLeaseResult | null,
): Error {
  if (refusal === null || refusal.outcome === 'acquired') {
    return new Error(`The "${key.operation}" lease on repository ${key.repositoryId} was neither granted nor refused.`);
  }
  const abandoned = refusal.outcome === 'abandoned';
  const holder = refusal.holder;
  // A live holder's stage is a moving target — it can change in the moment between the read and
  // the report — so only an abandoned lease, whose owner will never write again, is quoted.
  const stage = abandoned ? holder.stage : null;
  // What blocked the caller and what the caller asked for are two different operations now that
  // the lease excludes the whole repository. `operation` stays the request — that is what the
  // field has always meant, and a `--resume` suggestion has to name the caller's own command —
  // and `holderOperation` names what is actually in the way, so a `remove` refused by a running
  // `gc` says `gc` instead of blaming a second `remove` that does not exist.
  const holderOperation = holder.operation;
  const sameOperation = holderOperation === key.operation;
  return new RepositoryOperationConflictError(
    abandoned
      ? `A previous "${holderOperation}" on this repository stopped at stage ${stage === null ? '<none>' : `"${stage}"`} and its process (pid ${String(holder.pid)}) is gone.`
      : `Another wtm process is performing "${holderOperation}" on this repository (pid ${String(holder.pid)}, acquired ${holder.acquiredAt}).`,
    {
      abandoned,
      context: {
        repositoryId: key.repositoryId,
        operation: key.operation,
        holderOperation,
        holderPid: holder.pid,
        acquiredAt: holder.acquiredAt,
        stage,
        abandoned,
      },
      // Resuming is only ever an offer to finish the caller's *own* half-done operation. A dead
      // `gc` row is cleared out of a `remove`'s way by `--resume`, but suggesting
      // `wtm remove --resume` for a stage `gc` wrote would be offering to continue work this
      // command has no journal for.
      remediation: abandoned && sameOperation
        ? [{ kind: 'command-suggestion', argv: ['wtm', key.operation, '--resume'] }]
        : [],
    },
  );
}
