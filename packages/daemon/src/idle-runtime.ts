import type { IdlePolicy, ManagedProcessRecord } from '@wtm/core';

/**
 * Automatic idle suspension of managed tasks (todo item 14).
 *
 * What it is: a periodic sweep that stops a `RUNNING` managed task whose own `[tasks.<name>.idle]`
 * block opted in and which nobody has interacted with *through WTM* for the configured window.
 *
 * What it deliberately is not:
 *
 * - **It is not a new lifecycle state.** Suspension goes through the supervisor's ordinary stop
 *   (SIGTERM, grace, SIGKILL, identity verification) and the process ends in `STOPPED`, exactly as
 *   if somebody had typed `wtm stop`. That is what makes resume free: `wtm start <task>` already
 *   starts a singleton task that is not running, so there is no resume path to write, and there is
 *   no state a reader has to learn.
 * - **It is not traffic observation.** WTM has no reverse proxy, so the only activity it can see is
 *   its own: a start, a restart, a `wtm ps`, a `wtm logs`. A task serving a browser directly, with
 *   nobody touching WTM, reads as idle. Documented plainly in `docs/07`; not papered over here.
 * - **It is not persistent.** The clocks live in this map and nowhere else, so a daemon restart
 *   restarts every window from the moment the sweep next sees the process. No migration, no new
 *   column, and no rows to reconcile against processes that outlived a daemon.
 *
 * Two populations can never reach it, by construction rather than by a special case:
 * `wtm run`/`wtm exec` foreground processes are not supervised at all (they run in the CLI's own
 * process and have no `ManagedProcessRecord`), and heavy-queue jobs cannot carry a policy, because
 * the configuration schema refuses `idle` beside `queue = true` and `taskIdlePolicy` (`@wtm/core`)
 * refuses it a second time when reading.
 */
export interface IdleSuspensionSupervisor {
  list(worktreeId?: string): ManagedProcessRecord[];
  stopRecord(record: ManagedProcessRecord): Promise<ManagedProcessRecord>;
}

export interface IdleRuntimeSuspenderOptions {
  supervisor: IdleSuspensionSupervisor;
  /**
   * The idle policy of every opted-in task of one worktree. Read per sweep rather than captured at
   * start, so that a task already running when the daemon restarted is still covered, and so that
   * editing `wtm.toml` takes effect without restarting anything.
   */
  readIdlePolicies(worktreeId: string): Promise<ReadonlyMap<string, IdlePolicy>>;
  /** One line into the task's own log stream, saying why it was stopped. Best effort. */
  note?(record: ManagedProcessRecord, line: string): Promise<void>;
  /** Told after a suspension reached `STOPPED`, so `runtime.stopped` fires as it would for a stop. */
  onSuspended?(record: ManagedProcessRecord): void;
  now?(): number;
  /** How often the sweep runs. The window itself is per task; this is only its granularity. */
  intervalMs?: number;
  onError?(error: unknown): void;
}

/** The default sweep granularity: often enough for a 1s floor, rare enough for an idle daemon. */
export const defaultIdleSweepIntervalMs = 5_000;

export class IdleRuntimeSuspender {
  readonly #supervisor: IdleSuspensionSupervisor;
  readonly #readIdlePolicies: IdleRuntimeSuspenderOptions['readIdlePolicies'];
  readonly #note: NonNullable<IdleRuntimeSuspenderOptions['note']>;
  readonly #onSuspended: NonNullable<IdleRuntimeSuspenderOptions['onSuspended']>;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  /** Last interaction per `worktreeId\0taskName`, in epoch milliseconds. Memory only. */
  readonly #activity = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;
  #closed = false;

  constructor(options: IdleRuntimeSuspenderOptions) {
    this.#supervisor = options.supervisor;
    this.#readIdlePolicies = options.readIdlePolicies;
    this.#note = options.note ?? (async () => {});
    this.#onSuspended = options.onSuspended ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.#intervalMs = positiveInteger(options.intervalMs ?? defaultIdleSweepIntervalMs, 'Idle sweep interval');
    this.#onError = options.onError ?? (() => {});
  }

  /**
   * Record that WTM observed this task just now. Called for every daemon-handled request scoped to
   * it — start, restart, the readiness wait inside them, `logs` — and with no task name for a
   * request scoped to the whole worktree, such as `ps`, which asks about all of them at once.
   */
  touch(worktreeId: string, taskName?: string): void {
    if (this.#closed) return;
    const at = this.#now();
    if (taskName !== undefined) {
      this.#activity.set(activityKey(worktreeId, taskName), at);
      return;
    }
    for (const record of this.#supervisor.list(worktreeId)) {
      if (record.state === 'RUNNING') this.#activity.set(activityKey(worktreeId, record.taskName), at);
    }
  }

  start(): void {
    if (this.#closed || this.#timer !== null) return;
    this.#timer = setInterval(() => { void this.sweep(); }, this.#intervalMs);
    // The daemon's lifetime is the socket's, never a timer's.
    this.#timer.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#activity.clear();
  }

  /**
   * One pass. Returns what it suspended, which is what the tests assert on and what makes the
   * sweep callable directly from an injected clock instead of waited out in real time.
   *
   * A sweep never runs on top of another: stopping a process takes a grace period, and a second
   * sweep entering meanwhile would read a task that is already `STOPPING` as still idle.
   */
  async sweep(): Promise<ManagedProcessRecord[]> {
    if (this.#closed || this.#sweeping) return [];
    this.#sweeping = true;
    try { return await this.#sweepLocked(); }
    catch (error) { this.#onError(error); return []; }
    finally { this.#sweeping = false; }
  }

  async #sweepLocked(): Promise<ManagedProcessRecord[]> {
    // `cleanupRequired` rows are mid-recovery and belong to the supervisor's own repair path.
    const running = this.#supervisor.list()
      .filter((record) => record.state === 'RUNNING' && !record.cleanupRequired);
    this.#prune(running);
    if (running.length === 0) return [];

    const suspended: ManagedProcessRecord[] = [];
    const byWorktree = new Map<string, ManagedProcessRecord[]>();
    for (const record of running) {
      const group = byWorktree.get(record.worktreeId);
      if (group === undefined) byWorktree.set(record.worktreeId, [record]);
      else group.push(record);
    }

    for (const [worktreeId, records] of byWorktree) {
      let policies: ReadonlyMap<string, IdlePolicy>;
      // A workspace whose configuration stopped resolving must not take the sweep — and therefore
      // every other workspace's idle window — down with it.
      try { policies = await this.#readIdlePolicies(worktreeId); }
      catch (error) { this.#onError(error); continue; }
      if (policies.size === 0) continue;
      for (const record of records) {
        const policy = policies.get(record.taskName);
        if (policy === undefined) continue;
        const stopped = await this.#suspendIfIdle(record, policy);
        if (stopped !== null) suspended.push(stopped);
      }
    }
    return suspended;
  }

  async #suspendIfIdle(record: ManagedProcessRecord, policy: IdlePolicy): Promise<ManagedProcessRecord | null> {
    const key = activityKey(record.worktreeId, record.taskName);
    // A process this sweep has never seen before is dated from now, not from its `startedAt`. The
    // difference only shows after a daemon restart, and there it is the whole point: a window WTM
    // was not running for is a window it observed no interactions in because it was observing
    // nothing, and that is not evidence of idleness. For a task started while this daemon has been
    // up, the two readings differ by at most one sweep — the start itself is an interaction.
    //
    // The clock is keyed by worktree and task, which a replacement run shares with the run it
    // replaced, so an interaction older than this run's own start is not one of *its* interactions
    // and cannot shorten its window.
    const touched = this.#activity.get(key);
    const started = dateOrNull(record.startedAt);
    const since = touched === undefined ? this.#now()
      : started === null ? touched : Math.max(touched, started);
    this.#activity.set(key, since);
    if (this.#now() - since < policy.timeoutMs) return null;

    try {
      await this.#note(record, `[wtm] stopping ${record.taskName} after ${policy.timeout} without WTM interaction (idle.timeout = "${policy.timeout}"); start it again with: wtm start ${record.taskName}`);
    } catch (error) { this.#onError(error); }

    // Writing the note is I/O, and a request can arrive while it runs. A task somebody asked about
    // a moment ago is not idle, so the decision is re-checked against the clock rather than acted
    // on from a reading taken before the wait.
    if (this.#closed || this.#activity.get(key) !== since) return null;

    let result: ManagedProcessRecord;
    try { result = await this.#supervisor.stopRecord(record); }
    catch (error) {
      // A stop that failed leaves a `FAILED` row the supervisor already recorded, and the clock is
      // reset so the next sweep does not retry immediately and forever.
      this.#activity.set(key, this.#now());
      this.#onError(error);
      return null;
    }
    this.#activity.delete(key);
    if (result.state !== 'STOPPED') return null;
    try { this.#onSuspended(result); } catch (error) { this.#onError(error); }
    return result;
  }

  /** Clocks belong to running processes; a task that stopped starts a new window when it returns. */
  #prune(running: readonly ManagedProcessRecord[]): void {
    if (this.#activity.size === 0) return;
    const live = new Set(running.map((record) => activityKey(record.worktreeId, record.taskName)));
    for (const key of [...this.#activity.keys()]) {
      if (!live.has(key)) this.#activity.delete(key);
    }
  }
}

function activityKey(worktreeId: string, taskName: string): string { return `${worktreeId}\0${taskName}`; }

function dateOrNull(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}
