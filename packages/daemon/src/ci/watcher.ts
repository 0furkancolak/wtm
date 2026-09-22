import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateCiRuns, ciDeadline, ciPollPolicy, ciRepositoryFromSlug, CiWatchError, containsPath, isFailingConclusion,
  nextPollIntervalMs, parseCiRemote, summarizeFailedJobLog, throttledDelayMs,
  type CiProvider, type CiProviderFailure, type CiProviderResult, type CiRepository, type CiWatchRecord, type CiWatchStore,
  type StateRegistrationReader,
} from '@wtm/core';
import {
  ciArgumentSchemas, ciCommandNames,
  type CiJob, type CiRun, type CiWatch, type IpcRequest, type JsonEnvelope, type WtmError,
} from '@wtm/protocol';
import type { ReconcilerClock } from '../reconciler-queue';

export interface CiWatcherOptions {
  store: CiWatchStore;
  registration: Pick<StateRegistrationReader, 'listRepositories' | 'listWorktrees'>;
  provider: CiProvider;
  clock?: ReconcilerClock;
  onError?: (error: unknown) => void;
}

const systemClock: ReconcilerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class BudgetExhausted extends Error {}

export function publicCiWatch(record: CiWatchRecord): CiWatch {
  return {
    watchId: record.watchId, repo: record.providerRepo, branch: record.branch, headSha: record.headSha,
    ...(record.pr === null ? {} : { pr: record.pr }),
    state: record.state, startedAt: record.startedAt, updatedAt: record.updatedAt,
    ...(record.finishedAt === null ? {} : { finishedAt: record.finishedAt }),
    runs: record.runs,
    ...(record.detail === null ? {} : { detail: record.detail }),
  };
}

/**
 * Follows the CI of commits an agent asked about with `wtm ci watch`. One timer covers every
 * pending watch and none exists while nothing is pending, so an idle daemon does no work.
 */
export class CiWatcher {
  readonly #options: CiWatcherOptions;
  readonly #clock: ReconcilerClock;
  #timer: unknown = null;
  #operation: Promise<void> = Promise.resolve();
  #calls: number[] = [];
  #closed = false;

  constructor(options: CiWatcherOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    const now = this.#clock.now();
    for (const watch of this.#options.store.pending()) {
      // Only the 2-hour deadline is judged here: `no_runs` needs to know whether a run has ever
      // appeared, and the next poll (which reads `sawRuns` itself) is the one placed to decide
      // that correctly rather than guessing at restart.
      const deadline = ciDeadline({ startedAtMs: Date.parse(watch.startedAt), nowMs: now, sawRuns: true });
      if (deadline === 'timed_out') {
        this.#options.store.update(watch.watchId, { now: this.#iso(now), state: 'timed_out', detail: 'CI did not finish within 2 hours.' });
      } else {
        this.#options.store.update(watch.watchId, { now: this.#iso(now), nextPollAt: this.#iso(now + ciPollPolicy.firstDelayMs) });
      }
    }
    // After the loop, so a watch that just timed out above is pruned like any other finished one.
    this.#options.store.prune(this.#iso(now), ciPollPolicy.retentionMs);
    this.#arm();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    await this.#operation.catch(() => {});
  }

  /** Resolves once any in-flight tick has settled. For tests driving a fake clock. */
  async idle(): Promise<void> {
    await this.#operation.catch(() => {});
  }

  async handle(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    const command = request.command;
    if (!ciCommandNames.has(command)) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'Unknown CI command.', severity: 'error' });
    }
    const parsed = ciArgumentSchemas[command as keyof typeof ciArgumentSchemas].safeParse(request.arguments);
    if (!parsed.success) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'CI arguments are invalid.', severity: 'error' });
    }
    const registration = this.#registration(parsed.data.cwd);
    if (registration === null) {
      return failure(command, {
        code: 'WTM_WORKSPACE_NOT_FOUND', message: 'This directory is not inside a worktree registered with WTM.',
        severity: 'error', context: { cwd: parsed.data.cwd },
      });
    }
    const now = this.#clock.now();
    if (command === 'ci.unwatch') {
      const cancelled = this.#options.store.cancelPendingForWorktree(registration.worktree.id, this.#iso(now), 'Stopped by wtm ci unwatch.');
      if (cancelled !== null) this.#options.store.prune(this.#iso(now), ciPollPolicy.retentionMs);
      this.#arm();
      return success(command, { stopped: cancelled !== null, watch: cancelled === null ? null : publicCiWatch(cancelled) });
    }
    const args = parsed.data as { cwd: string; branch: string | null; headSha: string; pr?: number };
    const repository = parseCiRemote(registration.repository.remoteIdentity);
    if (repository === null) return failure(command, noProviderRefusal(registration.repository.remoteIdentity));
    // Watching the commit a pending watch already follows answers with that watch, before the auth
    // probe: nothing new is started, so there is nothing for `gh` to vouch for.
    const reusable = this.#options.store.latestForWorktree(registration.worktree.id);
    if (reusable !== null && reusable.state === 'pending' && reusable.headSha === args.headSha) {
      // A `--pr <n>` for the same commit a pending watch already follows still records it: the
      // reused watch is returned unchanged otherwise, but a supplied PR number must not be
      // silently dropped just because nothing new was started.
      const watch = args.pr !== undefined && args.pr !== reusable.pr
        ? this.#options.store.update(reusable.watchId, { now: this.#iso(now), pr: args.pr }) ?? reusable
        : reusable;
      return success(command, { watch: publicCiWatch(watch), reused: true });
    }
    // Corrections while planning (9): a transient or throttled answer here still accepts the
    // watch — only a missing `gh` or an unauthenticated host refuses. `unavailableRefusal`
    // returns null for every other reason, including `not-found`, so those fall through.
    //
    // The probe itself spends from the same 30-calls-per-minute budget every poll draws from
    // (spec §2: "at most 30 gh invocations per minute across all watches"). When the window is
    // already full, skip the probe rather than push the total past the cap — the outcome is the
    // same one a throttled answer would produce: the watch is accepted unexamined.
    this.#pruneCalls(now);
    const available: CiProviderResult<null> | null = this.#calls.length >= ciPollPolicy.callsPerMinute
      ? null
      : await this.#options.provider.checkAvailable(repository);
    if (available !== null) this.#calls.push(now);
    if (available !== null && !available.ok && available.failure.kind === 'unavailable') {
      // Spec §3: a host other than github.com counts as GitHub only when `gh auth status` succeeds
      // for it. Unauthenticated there means no CI provider, not a `gh auth login` suggestion for a
      // host that may not be GitHub at all.
      if (repository.host !== 'github.com' && available.failure.reason === 'unauthenticated') {
        return failure(command, noProviderRefusal(registration.repository.remoteIdentity));
      }
      const refusal = unavailableRefusal(available.failure, repository);
      if (refusal !== null) return failure(command, refusal);
    }
    try {
      const { watch, reused } = this.#options.store.start({
        repositoryId: registration.repository.id, worktreeId: registration.worktree.id, worktreePath: registration.worktree.path,
        providerRepo: repository.slug, branch: args.branch, headSha: args.headSha, pr: args.pr ?? null,
        now: this.#iso(now), nextPollAt: this.#iso(now + ciPollPolicy.firstDelayMs), pollIntervalMs: ciPollPolicy.firstDelayMs,
        maxPending: ciPollPolicy.maxPending,
      });
      this.#options.store.prune(this.#iso(now), ciPollPolicy.retentionMs);
      this.#arm();
      return success(command, { watch: publicCiWatch(watch), reused });
    } catch (error) {
      if (error instanceof CiWatchError) {
        return failure(command, {
          code: error.code, message: error.message, severity: 'error', context: error.context,
          remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'ci', 'unwatch', '--worktree', '<selector>'] }],
        });
      }
      throw error;
    }
  }

  #registration(cwd: string) {
    const current = canonical(resolve(cwd));
    const worktree = this.#options.registration.listWorktrees()
      .filter(({ path, state }) => state !== 'ORPHANED' && state !== 'REMOVED' && containsPath(canonical(path), current))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (worktree === undefined) return null;
    const repository = this.#options.registration.listRepositories().find(({ id }) => id === worktree.repositoryId);
    return repository === undefined ? null : { worktree, repository };
  }

  #arm(): void {
    if (this.#closed) return;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    const next = this.#options.store.pending()[0];
    if (next === undefined) return;
    const delay = Math.max(0, Date.parse(next.nextPollAt) - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#operation = this.#operation
        .then(async () => await this.#tick())
        .catch((error: unknown) => this.#options.onError?.(error))
        .finally(() => this.#arm());
    }, delay);
  }

  async #tick(): Promise<void> {
    for (const snapshot of this.#options.store.pending()) {
      if (this.#closed) return;
      if (Date.parse(snapshot.nextPollAt) > this.#clock.now()) break;
      // Re-read rather than trust the snapshot: an earlier watch's `await` in this same tick
      // gives a concurrent `ci.watch`/`ci.unwatch` a chance to cancel or supersede this one
      // before its turn comes up, and polling it after that would spend budget on a watch that
      // no longer exists to report the answer to.
      const watch = this.#options.store.get(snapshot.watchId);
      if (watch === null || watch.state !== 'pending' || Date.parse(watch.nextPollAt) > this.#clock.now()) continue;
      try {
        await this.#poll(watch);
      } catch (error) {
        if (!(error instanceof BudgetExhausted)) {
          // Left due, this watch would be re-armed at 0 ms and fail again in a tight loop. Wait
          // one interval first; the error is still reported through `onError` by `#arm`.
          const now = this.#clock.now();
          try {
            this.#options.store.update(watch.watchId, { now: this.#iso(now), nextPollAt: this.#iso(now + watch.pollIntervalMs) });
          } catch {
            // The original error is the one worth reporting.
          }
          throw error;
        }
        // The budget ran out mid-tick: every watch still due this tick (including the one that
        // just failed to spend) waits for the next minute's slots rather than being starved
        // forever behind watches earlier in `pending()`'s order.
        const oldest = this.#calls[0] ?? this.#clock.now();
        for (const waiting of this.#options.store.pending()) {
          if (Date.parse(waiting.nextPollAt) <= this.#clock.now()) {
            this.#options.store.update(waiting.watchId, { now: this.#iso(this.#clock.now()), nextPollAt: this.#iso(oldest + 60_000) });
          }
        }
        return;
      }
    }
  }

  #pruneCalls(now: number): void {
    this.#calls = this.#calls.filter((at) => at > now - 60_000);
  }

  #spend(): void {
    const now = this.#clock.now();
    this.#pruneCalls(now);
    if (this.#calls.length >= ciPollPolicy.callsPerMinute) throw new BudgetExhausted();
    this.#calls.push(now);
  }

  async #poll(watch: CiWatchRecord): Promise<void> {
    const now = this.#clock.now();
    const iso = this.#iso(now);
    const finish = (state: CiWatchRecord['state'], detail: string | null, runs?: CiRun[]) => {
      this.#options.store.update(watch.watchId, { now: iso, state, detail, ...(runs === undefined ? {} : { runs }) });
      this.#options.store.prune(iso, ciPollPolicy.retentionMs);
    };
    const deadline = ciDeadline({ startedAtMs: Date.parse(watch.startedAt), nowMs: now, sawRuns: watch.sawRuns });
    if (deadline === 'timed_out') { finish('timed_out', 'CI did not finish within 2 hours.'); return; }
    const repository = ciRepositoryFromSlug(watch.providerRepo);
    if (repository === null) { finish('unavailable', 'The stored repository name is invalid.'); return; }

    this.#spend();
    const listed = await this.#options.provider.listRuns(repository, watch.headSha);
    if (!listed.ok) { this.#failed(watch, listed.failure); return; }
    if (listed.value.length === 0) {
      if (deadline === 'no_runs') { finish('no_runs', 'No CI run appeared for this commit within 3 minutes.'); return; }
      this.#reschedule(watch, false, {});
      return;
    }

    const previous = new Map(watch.runs.map((entry) => [entry.runId, entry]));
    const runs: CiRun[] = [];
    for (const current of listed.value) {
      const stored = previous.get(current.runId);
      let jobs: CiJob[] = stored?.jobs ?? [];
      if (stored === undefined || stored.status !== current.status || stored.conclusion !== current.conclusion || current.status !== 'completed' || jobs.length === 0) {
        this.#spend();
        const answer = await this.#options.provider.listJobs(repository, current.runId);
        if (!answer.ok) { this.#failed(watch, answer.failure); return; }
        const summaries = new Map(jobs.map((entry) => [entry.jobId, entry.logSummary]));
        jobs = answer.value.map((entry) => {
          const summary = summaries.get(entry.jobId);
          return summary === undefined ? entry : { ...entry, logSummary: summary };
        });
      }
      runs.push({ ...current, jobs });
    }
    const changed = fingerprint(runs) !== fingerprint(watch.runs);
    const verdict = aggregateCiRuns(runs);
    if (verdict === 'pending') { this.#reschedule(watch, changed, { runs, sawRuns: true }); return; }

    // Complete: fetch one log per failed job, saving progress so a budget stop loses nothing.
    for (const current of runs) {
      for (const [index, entry] of current.jobs.entries()) {
        if (entry.logSummary !== undefined || entry.status !== 'completed' || !isFailingConclusion(entry.conclusion)) continue;
        try {
          this.#spend();
        } catch (error) {
          this.#options.store.update(watch.watchId, { now: iso, runs, sawRuns: true });
          throw error;
        }
        const log = await this.#options.provider.failedJobLog(repository, current.runId, entry.jobId);
        if (!log.ok && log.failure.kind !== 'unavailable') {
          // Rate-limited or a transient answer: spec §2 says this delays the watch rather than
          // losing data. Save the runs gathered so far — this job's summary stays unset — and
          // let the existing failure-delay path retry it on the watch's next poll, instead of
          // guessing at a placeholder the way an `unavailable` answer does below.
          this.#options.store.update(watch.watchId, { now: iso, runs, sawRuns: true });
          this.#failed(watch, log.failure);
          return;
        }
        current.jobs[index] = { ...entry, logSummary: log.ok ? summarizeFailedJobLog(log.value) : `(log unavailable: ${log.failure.detail})` };
      }
    }
    this.#options.store.update(watch.watchId, { now: iso, sawRuns: true, failureStreak: 0 });
    finish(verdict === 'none' ? 'no_runs' : verdict, null, runs);
  }

  #reschedule(watch: CiWatchRecord, changed: boolean, extra: { runs?: CiRun[]; sawRuns?: boolean }): void {
    const now = this.#clock.now();
    // Spec §2: the interval grows ×1.5 from the first poll whether or not a run has appeared yet.
    const interval = nextPollIntervalMs(watch.pollIntervalMs, changed);
    let nextPollAt = now + interval;
    // Before any run appears, never sleep past the 3-minute `no_runs` deadline.
    if (!watch.sawRuns && extra.sawRuns !== true) {
      nextPollAt = Math.min(nextPollAt, Date.parse(watch.startedAt) + ciPollPolicy.noRunsAfterMs);
    }
    this.#options.store.update(watch.watchId, {
      now: this.#iso(now), nextPollAt: this.#iso(nextPollAt), pollIntervalMs: interval, failureStreak: 0,
      ...(extra.runs === undefined ? {} : { runs: extra.runs }), ...(extra.sawRuns === undefined ? {} : { sawRuns: extra.sawRuns }),
    });
  }

  #failed(watch: CiWatchRecord, failure: CiProviderFailure): void {
    const now = this.#clock.now();
    if (failure.kind !== 'unavailable') {
      this.#options.store.update(watch.watchId, { now: this.#iso(now), nextPollAt: this.#iso(now + throttledDelayMs(watch.pollIntervalMs)) });
      return;
    }
    const streak = watch.failureStreak + 1;
    if (streak >= ciPollPolicy.unavailableAfterFailures) {
      this.#options.store.update(watch.watchId, { now: this.#iso(now), state: 'unavailable', detail: failure.detail, failureStreak: streak });
      this.#options.store.prune(this.#iso(now), ciPollPolicy.retentionMs);
      return;
    }
    this.#options.store.update(watch.watchId, { now: this.#iso(now), failureStreak: streak, nextPollAt: this.#iso(now + watch.pollIntervalMs) });
  }

  #iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function fingerprint(runs: readonly CiRun[]): string {
  return JSON.stringify(runs.map((entry) => [entry.runId, entry.status, entry.conclusion, entry.jobs.map((job) => [job.jobId, job.status, job.conclusion])]));
}

function noProviderRefusal(remote: string | null): WtmError {
  return { code: 'WTM_CI_UNAVAILABLE', message: 'No CI provider for this remote.', severity: 'error', context: { remote } };
}

function unavailableRefusal(failure: Extract<CiProviderFailure, { kind: 'unavailable' }>, repository: CiRepository): WtmError | null {
  if (failure.reason === 'missing') {
    return {
      code: 'WTM_CI_UNAVAILABLE', message: 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com.',
      severity: 'error', context: { provider: 'github' },
    };
  }
  if (failure.reason === 'unauthenticated') {
    return {
      code: 'WTM_CI_UNAVAILABLE', message: `The GitHub CLI is not logged in to ${repository.host}.`, severity: 'error',
      context: { provider: 'github', host: repository.host },
      remediation: [{ kind: 'command-suggestion', argv: ['gh', 'auth', 'login', '--hostname', repository.host] }],
    };
  }
  return null;
}

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return { schemaVersion: 1, command, ok: true, data, warnings: [], errors: [] };
}

function failure(command: string, error: WtmError): JsonEnvelope<unknown> {
  return { schemaVersion: 1, command, ok: false, data: null, warnings: [], errors: [error] };
}
