/**
 * The removal lifecycle: the one place that owns the *order* in which a worktree is taken apart.
 *
 * Core keeps that order and hands the runtime work to a {@link RemovalRuntimeCoordinator} the
 * caller supplies, so core never learns what a daemon is: the CLI owns the connection, and this
 * module owns the sequence, the safety checks around it, and the two locks that keep two removals
 * out of one repository.
 */
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WtmError } from '@wtm/protocol';
import {
  readGitCommonDirectory,
  runGit,
} from '../git/git-runner';
import { containsPath } from '../paths/contains';
import {
  withRepositoryOperationLease,
  type RepositoryOperationLeaseStore,
  type RepositoryOperationSession,
} from './operation-lease';
import { assertRemovable, WorktreeRemovalBlockedError } from './remove-policy';
import {
  analyzeWorktree,
  WorktreeAnalysisError,
  type WorktreeAnalysis,
  type WorktreeContext,
} from './worktree-analysis';

/** The worktree a removal is acting on, in the identifiers the runtime side knows it by. */
export interface RemovalSubject {
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
}

export interface StoppedProcessesReport {
  stopped: number;
}

/**
 * What the state database still says about the worktree's managed processes after a stop:
 * records in a live state, and records that still owe durable cleanup.
 */
export interface ManagedProcessResidue {
  active: number;
  cleanupOwed: number;
}

export interface EphemeralCleanupReport {
  collected: number;
  retained: { name: string; reason: string }[];
}

export interface EndpointReleaseReport {
  released: number;
}

/**
 * The runtime half of a removal. Every method must be idempotent: `--resume` re-enters the
 * lifecycle from the top, and a stage that already completed is run again rather than trusted.
 * A method that cannot complete throws, which stops the lifecycle before Git deletes anything.
 */
export interface RemovalRuntimeCoordinator {
  /**
   * The absolute paths inside the worktree that WTM materialized and the cleanup stage would
   * collect.
   *
   * The lifecycle asks before it decides whether a Git blocker is a reason to refuse, because
   * core deliberately does not know what a resource is: without this answer, a `node_modules`
   * WTM created is untracked content like any other and refuses the very removal that would
   * have deleted it. Answering with fewer paths is always safe — it refuses; answering with a
   * path the cleanup will not actually collect is not, because the second gate then refuses
   * after the processes have already been stopped.
   */
  reclaimablePaths(subject: RemovalSubject): Promise<readonly string[]>;
  stopManagedProcesses(subject: RemovalSubject): Promise<StoppedProcessesReport>;
  verifyManagedProcessesStopped(subject: RemovalSubject): Promise<ManagedProcessResidue>;
  cleanupEphemeralResources(subject: RemovalSubject): Promise<EphemeralCleanupReport>;
  releaseEndpointLeases(subject: RemovalSubject): Promise<EndpointReleaseReport>;
  reconcile(subject: RemovalSubject): Promise<void>;
}

/**
 * The stages of a removal, in the order they run. Each one is journalled on the repository
 * operation lease as it is *entered*, so an interrupted removal leaves behind the name of the
 * step its process died inside.
 */
export const removalStages = [
  'analyze',
  'stop-processes',
  'verify-processes',
  'cleanup-resources',
  'release-endpoints',
  'reanalyze',
  'git-remove',
  'reconcile',
] as const;

export type RemovalStage = (typeof removalStages)[number];

export interface GuardedRemovalInput {
  context: WorktreeContext;
  /**
   * Omitting this keeps the pre-runtime behaviour — analyze, re-analyze, remove — and is what the
   * Git-only tests use. It is not a production path: the CLI always supplies a coordinator, so a
   * worktree with running managed processes can never reach Git without them being stopped first.
   */
  coordinator?: RemovalRuntimeCoordinator | undefined;
  /**
   * Omitting this runs without the cross-process lease. Same rule as above: the CLI always
   * supplies one, and without it only the in-process mutex serializes callers.
   */
  lease?: {
    store: RepositoryOperationLeaseStore;
    repositoryId: string;
    adopt?: boolean | undefined;
  } | undefined;
}

export interface GuardedRemovalResult {
  analysis: WorktreeAnalysis;
  cleanup: {
    stoppedProcesses: number;
    releasedEndpoints: number;
    collectedResources: number;
    retainedResources: { name: string; reason: string }[];
  };
  /**
   * The blockers the first gate handed to the cleanup stage instead of refusing on, exactly as
   * the analysis raised them. Always empty on the Git-only path.
   *
   * They are reported rather than warned about: a worktree that ran a task is *expected* to hold
   * the directories WTM put there, so warning on every such removal would train the reader to
   * ignore the warning. But the removal did proceed over a refusal the analysis raised, and a
   * result that does not say so leaves no way to tell a deferral from a worktree that was clean
   * all along — which is precisely the confusion that hid this bug.
   */
  deferredBlockers: readonly WtmError[];
  /** The stage an adopted lease had reached, and null when this removal started fresh. */
  resumedFrom: RemovalStage | null;
}

/**
 * Managed process records that outlived their stop. This is a refusal, not a Git failure: the
 * worktree is intact and the runtime has not let go of it.
 */
export class ManagedProcessResidueError extends Error {
  readonly code = 'RUNTIME_STOP_FAILED' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(subject: RemovalSubject, residue: ManagedProcessResidue) {
    super(
      `The worktree at ${subject.worktreePath} still has ${String(residue.active)} active managed `
      + `process record(s) and ${String(residue.cleanupOwed)} owing durable cleanup, so it was not removed.`,
    );
    this.name = 'ManagedProcessResidueError';
    this.context = Object.freeze({
      repositoryId: subject.repositoryId,
      worktreeId: subject.worktreeId,
      worktreePath: subject.worktreePath,
      active: residue.active,
      cleanupOwed: residue.cleanupOwed,
    });
  }
}

interface GuardedRemovalHooks {
  afterInitialAnalysis?(analysis: WorktreeAnalysis): void | Promise<void>;
  onMutexWait?(): void;
  afterMutexAcquired?(): void;
}

interface RepositoryMutex {
  tail: Promise<void>;
  release: () => void;
}

const repositoryMutexes = new Map<string, RepositoryMutex>();

/**
 * The pre-runtime entry point, kept at its original signature for callers that only need the
 * Git safety guarantee. It delegates to {@link removeWorktreeGuarded} with no coordinator.
 */
export async function removeWorktreeSafely(
  context: WorktreeContext,
): Promise<WorktreeAnalysis> {
  return removeWorktreeSafelyWithHooks(context, {});
}

export async function removeWorktreeSafelyWithHooks(
  context: WorktreeContext,
  hooks: GuardedRemovalHooks,
): Promise<WorktreeAnalysis> {
  const result = await removeWorktreeGuardedWithHooks({ context }, hooks);
  return result.analysis;
}

export async function removeWorktreeGuarded(
  input: GuardedRemovalInput,
): Promise<GuardedRemovalResult> {
  return removeWorktreeGuardedWithHooks(input, {});
}

export async function removeWorktreeGuardedWithHooks(
  input: GuardedRemovalInput,
  hooks: GuardedRemovalHooks,
): Promise<GuardedRemovalResult> {
  const commonGitDirectory = await readGitCommonDirectory(input.context.repoPath);
  const repositoryKey = await realpath(commonGitDirectory);
  // Both locks exist because they answer different questions. The in-process mutex makes callers
  // inside one process *queue*, which is what the daemon's own call sites need. The repository
  // operation lease makes callers in other processes *fail fast*, because a destructive command
  // that waits an unbounded time behind another one is worse than one that names it. The lease is
  // taken inside the mutex so a queued in-process caller does not burn its turn on a refusal.
  return withRepositoryMutex(repositoryKey, hooks, async () =>
    withOptionalLease(input, async (session) => runRemovalLifecycle(input, hooks, session)));
}

async function withOptionalLease<T>(
  input: GuardedRemovalInput,
  body: (session: RepositoryOperationSession | null) => Promise<T>,
): Promise<T> {
  const lease = input.lease;
  if (lease === undefined) return body(null);
  return withRepositoryOperationLease({
    store: lease.store,
    repositoryId: lease.repositoryId,
    operation: 'remove',
    ...(input.context.worktreeId === undefined ? {} : { subjectWorktreeId: input.context.worktreeId }),
    ...(lease.adopt === undefined ? {} : { adopt: lease.adopt }),
  }, body);
}

async function runRemovalLifecycle(
  input: GuardedRemovalInput,
  hooks: GuardedRemovalHooks,
  session: RepositoryOperationSession | null,
): Promise<GuardedRemovalResult> {
  const context = input.context;
  const coordinator = input.coordinator;
  const record = (stage: RemovalStage): void => {
    session?.advance(stage);
  };

  record('analyze');
  const initialAnalysis = await analyzeWorktree(context);
  // The *first* gate fails fast, so a worktree holding real uncommitted work is refused before
  // anything is stopped or deleted. What it must not do is refuse over content WTM itself
  // materialized: that content is the reason `cleanup-resources` exists, and refusing in front
  // of that stage made the stage unreachable in production. So a blocker naming only paths the
  // coordinator says it is about to collect waits for it. Nothing is authorized here — the
  // deletion is still gated by the re-analysis below, which sees whatever cleanup left behind.
  const deferredBlockers = await deferrableBlockers(context, initialAnalysis, coordinator);
  if (deferredBlockers.length === 0) {
    assertRemovable(initialAnalysis);
  } else {
    const refusals = initialAnalysis.safety.blockers.filter((blocker) => !deferredBlockers.includes(blocker));
    if (refusals.length > 0) throw new WorktreeRemovalBlockedError(refusals);
  }
  const identityToken = removalIdentityToken(initialAnalysis);

  await hooks.afterInitialAnalysis?.(initialAnalysis);

  let stoppedProcesses = 0;
  let releasedEndpoints = 0;
  let collectedResources = 0;
  let retainedResources: { name: string; reason: string }[] = [];

  if (coordinator !== undefined) {
    const subject = removalSubject(context, initialAnalysis);

    record('stop-processes');
    stoppedProcesses = (await coordinator.stopManagedProcesses(subject)).stopped;

    record('verify-processes');
    const residue = await coordinator.verifyManagedProcessesStopped(subject);
    // The state database, not the stop response, decides whether the processes are gone. A
    // durable-cleanup-ownership failure is exactly the case where the response looks finished and
    // the record disagrees, and that record is the one that outlives this process.
    if (residue.active > 0 || residue.cleanupOwed > 0) {
      throw new ManagedProcessResidueError(subject, residue);
    }

    record('cleanup-resources');
    const cleanup = await coordinator.cleanupEphemeralResources(subject);
    collectedResources = cleanup.collected;
    retainedResources = [...cleanup.retained];

    record('release-endpoints');
    releasedEndpoints = (await coordinator.releaseEndpointLeases(subject)).released;
  }

  // The *second* analysis is the one that gates `git worktree remove`, and it deliberately runs
  // after cleanup rather than beside the first one. Stopping a dev server can write a log line or
  // flush a build artifact into the worktree, so a removal that passed its safety check before
  // that write and deleted afterwards would delete an untracked file. The re-analysis is not a
  // formality: it is the check that covers cleanup's own side effects, and the identity comparison
  // is what closes the window in which someone else moved HEAD.
  record('reanalyze');
  const finalAnalysis = await analyzeWorktree(context);
  assertRemovable(finalAnalysis);
  assertIdentityUnchanged(identityToken, finalAnalysis);

  record('git-remove');
  await runGit(context.repoPath, ['worktree', 'remove', '--', finalAnalysis.identity.path]);

  if (coordinator !== undefined) {
    record('reconcile');
    await coordinator.reconcile(removalSubject(context, finalAnalysis));
  }

  return {
    analysis: finalAnalysis,
    cleanup: { stoppedProcesses, releasedEndpoints, collectedResources, retainedResources },
    deferredBlockers,
    resumedFrom: adoptedStage(session),
  };
}

/**
 * The blockers the cleanup stage is expected to resolve, and only those.
 *
 * The coordinator is consulted only when an untracked blocker is actually standing in the way:
 * no other blocker is ever deferrable, so asking otherwise would spend a runtime resolution on a
 * removal that is going to refuse anyway. Everything here fails closed — an unrecognised context,
 * a path that does not resolve inside a reclaimable one, a single real file named alongside the
 * reclaimable ones — because a blocker deferred by mistake is work deleted by mistake.
 */
async function deferrableBlockers(
  context: WorktreeContext,
  analysis: WorktreeAnalysis,
  coordinator: RemovalRuntimeCoordinator | undefined,
): Promise<readonly WtmError[]> {
  if (coordinator === undefined) return [];
  const candidates = analysis.safety.blockers.filter((blocker) => blocker.code === 'GIT_UNTRACKED');
  if (candidates.length === 0) return [];
  const reclaimable = await coordinator.reclaimablePaths(removalSubject(context, analysis));
  if (reclaimable.length === 0) return [];
  return candidates.filter((blocker) => namesOnlyReclaimablePaths(blocker, analysis.identity.path, reclaimable));
}

/**
 * Whether every path this blocker names is inside something WTM is about to collect.
 *
 * The paths come from the analysis worktree-relative, so they are resolved against the worktree
 * Git reported rather than against the caller's spelling of it. A blocker whose context does not
 * carry a usable `paths` array is not deferrable: an untracked blocker WTM cannot read the extent
 * of is one it cannot prove is harmless.
 */
function namesOnlyReclaimablePaths(
  blocker: WtmError,
  worktreePath: string,
  reclaimable: readonly string[],
): boolean {
  const paths = blocker.context?.['paths'];
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every((path) => typeof path === 'string'
    && reclaimable.some((root) => containsPath(root, resolve(worktreePath, path))));
}

/**
 * `resumedFrom` is reported, not obeyed. Every stage at or before it is re-run, because every
 * coordinator method is idempotent and re-running one is cheaper than trusting a stage record
 * written by a process that then died — the record says where that process stopped writing, not
 * what it finished doing.
 */
function adoptedStage(session: RepositoryOperationSession | null): RemovalStage | null {
  const stage = session?.adoptedStage ?? null;
  if (stage === null) return null;
  return isRemovalStage(stage) ? stage : null;
}

function isRemovalStage(stage: string): stage is RemovalStage {
  return (removalStages as readonly string[]).includes(stage);
}

/**
 * The runtime side identifies a worktree by its recorded ids, so a coordinator cannot be driven
 * without them. The path comes from Git rather than from the caller's spelling of it.
 */
function removalSubject(context: WorktreeContext, analysis: WorktreeAnalysis): RemovalSubject {
  const repositoryId = context.repositoryId;
  const worktreeId = context.worktreeId;
  if (repositoryId === undefined || worktreeId === undefined) {
    throw new WorktreeAnalysisError(
      'A runtime-aware removal needs the worktree\'s recorded identity: both repositoryId and worktreeId must be set on the context.',
      { repositoryId: repositoryId ?? null, worktreeId: worktreeId ?? null, worktreePath: analysis.identity.path },
    );
  }
  return { repositoryId, worktreeId, worktreePath: analysis.identity.path };
}

async function withRepositoryMutex<T>(
  repositoryKey: string,
  hooks: GuardedRemovalHooks,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositoryMutexes.get(repositoryKey);
  if (previous !== undefined) hooks.onMutexWait?.();

  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previousTail = previous?.tail ?? Promise.resolve();
  const entry = { tail: previousTail.then(() => turn), release };
  repositoryMutexes.set(repositoryKey, entry);

  await previousTail;
  try {
    hooks.afterMutexAcquired?.();
    return await operation();
  } finally {
    entry.release();
    if (repositoryMutexes.get(repositoryKey) === entry) repositoryMutexes.delete(repositoryKey);
  }
}

interface RemovalIdentityToken {
  path: string;
  headOid: string;
  branchRef: string | null;
  detached: boolean;
  isMain: boolean;
}

function removalIdentityToken(analysis: WorktreeAnalysis): RemovalIdentityToken {
  return {
    path: analysis.identity.path,
    headOid: analysis.identity.headOid,
    branchRef: analysis.identity.branchRef,
    detached: analysis.identity.detached,
    isMain: analysis.identity.isMain,
  };
}

function assertIdentityUnchanged(token: RemovalIdentityToken, analysis: WorktreeAnalysis): void {
  const current = removalIdentityToken(analysis);
  if (
    token.path !== current.path
    || token.headOid !== current.headOid
    || token.branchRef !== current.branchRef
    || token.detached !== current.detached
    || token.isMain !== current.isMain
  ) {
    throw new WorktreeAnalysisError(
      'Worktree identity changed between removal safety checks.',
      { initial: token, current },
    );
  }
}
