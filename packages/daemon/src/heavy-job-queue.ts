import { createHash } from 'node:crypto';
import {
  captureSourceSnapshot, HeavyJobError, memoryEstimateError,
  type HeavyJobRecord, type HeavyJobStore, type ManagedProcessRecord, type SourceSnapshot, type JobMemoryAdmission,
} from '@wtm/core';
import { jobArgumentSchemas, jobCommandNames, type EnqueueAcceptance, type IpcRequest, type JobWaitingReason, type JsonEnvelope, type SourceValidity, type WtmErrorCode } from '@wtm/protocol';
import type { ManagedProcessCompletion } from './logs';
import type { ManagedProcessStartInput, ManagedProcessStartResult, ProcessGroupInspection } from './process-supervisor';
import { readHostJobMemory, sanitizeHostJobMemory, type HostJobMemory } from './job-memory';

export interface ResolvedHeavyJob {
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
  taskName: string;
  timeoutMs: number;
  memoryEstimateBytes?: number | null;
  argv: readonly string[];
  cwd: string;
  shell: boolean;
  env: NodeJS.ProcessEnv;
}

interface QueueSupervisor {
  start(input: ManagedProcessStartInput): Promise<ManagedProcessStartResult>;
  stopRecord(record: ManagedProcessRecord): Promise<ManagedProcessRecord>;
  list(worktreeId?: string): ManagedProcessRecord[];
  confirmStopped?(record: ManagedProcessRecord): Promise<void>;
}

interface QueueLogs {
  read(path: string, maxBytes?: number): Promise<string>;
  readCompletion(stdoutPath: string, pid: number): Promise<ManagedProcessCompletion | null>;
  removeJob(worktreeId: string, jobId: string): Promise<void>;
}

export interface HeavyJobQueueOptions {
  store: HeavyJobStore;
  scope: string;
  supervisor: QueueSupervisor;
  resolveTask(cwd: string, taskName: string): Promise<ResolvedHeavyJob>;
  inspectGroup(pgid: number): Promise<ProcessGroupInspection>;
  maxConcurrent?: number;
  memory?: { budgetBytes: number; reserveBytes: number };
  readMemory?: () => HostJobMemory;
  snapshot?: (root: string) => Promise<SourceSnapshot>;
  logs?: QueueLogs;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

type ObservedExit = { exitCode: number | null; signal: NodeJS.Signals | null; groupAbsent: boolean; exitedAt?: string };

/** One scheduler for every repository of this daemon's private, host/user-scoped SQLite state. */
export class HeavyJobQueue {
  readonly #options: HeavyJobQueueOptions;
  readonly #snapshot: (root: string) => Promise<SourceSnapshot>;
  readonly #now: () => Date;
  readonly #exits = new Map<string, ObservedExit>();
  readonly #recovering = new Set<string>();
  readonly #stopAttempts = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #operation: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #admissions = 0;

  constructor(options: HeavyJobQueueOptions) {
    this.#options = options;
    this.#snapshot = options.snapshot ?? captureSourceSnapshot;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(options.maxConcurrent ?? 1) || (options.maxConcurrent ?? 1) < 1) throw new TypeError('Invalid heavy-job concurrency');
    if (options.memory !== undefined && (!Number.isSafeInteger(options.memory.budgetBytes)
      || options.memory.budgetBytes < 1 || options.memory.budgetBytes > 1_099_511_627_776
      || !Number.isSafeInteger(options.memory.reserveBytes) || options.memory.reserveBytes < 0
      || options.memory.reserveBytes > 1_099_511_627_776)) throw new TypeError('Invalid heavy-job memory policy');
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error('Heavy job queue is closed');
    for (const job of this.#options.store.active(this.#options.scope)) if (job.slotHeld) this.#recovering.add(job.jobId);
    this.#started = true;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#operation;
    this.#exits.clear(); this.#recovering.clear(); this.#stopAttempts.clear();
  }

  async enqueue(cwd: string, taskName: string, idempotencyKey: string): Promise<EnqueueAcceptance> {
    if (this.#closed) throw new Error('Heavy job queue is closed');
    if (this.#admissions >= 2) throw new HeavyJobError('WTM_JOB_QUEUE_FULL', 'Two job admission checks are already in progress; retry with the same idempotency key.');
    this.#admissions += 1;
    try { return await this.#enqueue(cwd, taskName, idempotencyKey); }
    finally { this.#admissions -= 1; }
  }

  async #enqueue(cwd: string, taskName: string, idempotencyKey: string): Promise<EnqueueAcceptance> {
    const task = await this.#options.resolveTask(cwd, taskName);
    const memory = this.#memory();
    const memoryError = memory === undefined ? null : memoryEstimateError(task.memoryEstimateBytes, memory);
    if (memoryError !== null) throw new HeavyJobError(memoryError,
      memoryError === 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED' ? 'Memory admission requires a positive task memory estimate.' : 'Task memory estimate cannot fit the configured or host memory budget.',
      { taskName, memoryEstimateBytes: task.memoryEstimateBytes ?? null, budgetBytes: memory!.budgetBytes, reserveBytes: memory!.reserveBytes, totalBytes: memory!.totalBytes });
    const source = await this.#snapshot(task.worktreePath);
    await this.#prune();
    const { job, reused } = this.#options.store.enqueue({
      scope: this.#options.scope, workspaceId: task.workspaceId, repositoryId: task.repositoryId,
      worktreeId: task.worktreeId, worktreePath: task.worktreePath, taskName,
      commandFingerprint: commandFingerprint(task), sourceFingerprint: source.fingerprint,
      timeoutMs: task.timeoutMs, memoryEstimateBytes: task.memoryEstimateBytes ?? null, idempotencyKey, now: this.#now().toISOString(),
    });
    // Never await dispatch here: the acknowledgement means only that SQLite committed the job.
    this.#schedule(0);
    return { jobId: job.jobId, state: job.state, accepted: true, idempotencyKey, reused };
  }

  get(jobId: string): HeavyJobRecord {
    const job = this.#options.store.get(jobId, this.#options.scope);
    if (job === null) throw new HeavyJobError('WTM_JOB_NOT_FOUND', 'Job was not found in this host/user queue.', { jobId });
    return job;
  }

  async cancel(jobId: string): Promise<HeavyJobRecord> {
    this.#options.store.requestCancellation(jobId, this.#options.scope, 'CANCELLED', this.#now().toISOString());
    await this.flush();
    return this.get(jobId);
  }

  recordExit(record: ManagedProcessRecord, outcome: ObservedExit): void {
    if (!record.taskName.startsWith('job-') || this.#closed) return;
    const jobId = record.taskName.slice(4);
    const job = this.#options.store.get(jobId, this.#options.scope);
    if (job?.processId !== record.id || !job.slotHeld) return;
    this.#exits.set(jobId, outcome);
    this.#schedule(0);
  }

  async flush(): Promise<void> {
    if (this.#closed || !this.#started) return;
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
    const next = this.#operation.then(async () => {
      if (this.#closed) return;
      for (const job of this.#options.store.active(this.#options.scope)) {
        if (job.slotHeld) await this.#reconcile(job);
      }
      if (!this.#closed) {
        for (let count = 0; count < (this.#options.maxConcurrent ?? 1); count += 1) {
          const job = this.#options.store.claim(this.#options.scope, this.#options.maxConcurrent ?? 1, this.#now().toISOString(), this.#memory());
          if (job === null) break;
          await this.#launch(job);
        }
      }
      if (this.#options.store.active(this.#options.scope).length > 0) this.#schedule(1000);
    });
    this.#operation = next.catch((error: unknown) => { this.#options.onError?.(error); this.#schedule(1000); });
    await next;
  }

  async handle(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    const command = request.command;
    try {
      if (!jobCommandNames.has(command)) throw new Error('INVALID_COMMAND');
      const parsed = jobArgumentSchemas[command as keyof typeof jobArgumentSchemas].safeParse(request.arguments);
      if (!parsed.success) return failure(command, 'WTM_DAEMON_INVALID_REQUEST', 'Job arguments are invalid.');
      const args = parsed.data as { cwd?: string; taskName?: string; idempotencyKey?: string; limit?: number; jobId?: string; tail?: number };
      if (command === 'jobs.enqueue') return success(command, await this.enqueue(args.cwd!, args.taskName!, args.idempotencyKey!));
      if (command === 'jobs.list') {
        const records = this.#options.store.list(this.#options.scope, args.limit);
        const memory = this.#memory();
        const waiting = this.#options.store.waitingReasons(this.#options.scope, this.#options.maxConcurrent ?? 1, memory);
        const jobs: ReturnType<typeof publicJob>[] = [];
        let bytes = 0;
        for (const record of records) {
          const job = publicJob(record, waiting);
          bytes += Buffer.byteLength(JSON.stringify(job)) + 1;
          if (bytes > 128 * 1024) break;
          jobs.push(job);
        }
        return success(command, { jobs, truncated: jobs.length < records.length, memory: memory ?? null });
      }
      const job = this.get(args.jobId!);
      if (command === 'jobs.cancel') return success(command, { job: publicJob(await this.cancel(job.jobId)), memory: this.#memory() ?? null });
      if (command === 'jobs.logs') {
        const record = this.#process(job);
        const bound = 32 * 1024;
        const stdout = record === null || this.#options.logs === undefined ? '' : await this.#options.logs.read(record.stdoutPath, bound);
        const stderr = record === null || this.#options.logs === undefined ? '' : await this.#options.logs.read(record.stderrPath, bound);
        return success(command, { jobId: job.jobId, stdout: tailLines(stdout, args.tail ?? 100), stderr: tailLines(stderr, args.tail ?? 100), truncated: Buffer.byteLength(stdout) >= bound || Buffer.byteLength(stderr) >= bound });
      }
      const memory = this.#memory();
      const waiting = this.#options.store.waitingReasons(this.#options.scope, this.#options.maxConcurrent ?? 1, memory);
      const sourceValidity = await this.#sourceValidity(job);
      const current = { ...publicJob(job, waiting), sourceValidity };
      if (command === 'jobs.status') return success(command, { job: current, memory: memory ?? null });
      const terminal = job.state !== 'QUEUED' && job.state !== 'RUNNING' && !job.slotHeld;
      // Old daemons could finalize a stale success after accepting a stop request. Preserve
      // that immutable history, but never expose it as successful validation to an agent.
      const successful = terminal && job.state === 'SUCCEEDED' && job.stopReason === null
        && job.exitCode === 0 && job.signal === null && sourceValidity === 'UNCHANGED';
      const data = { job: current, terminal, successful, sourceValidity, memory: memory ?? null };
      if (!terminal) return failure(command, 'WTM_JOB_NOT_COMPLETE', 'Job has not completed; acceptance is not a successful result.', data);
      if (sourceValidity !== 'UNCHANGED') return failure(command, 'WTM_JOB_SOURCE_CHANGED', 'Job result does not verify the current source state.', data);
      if (!successful) return failure(command, 'WTM_JOB_UNSUCCESSFUL', 'Job did not complete successfully.', data);
      return success(command, data);
    } catch (error) {
      if (error instanceof HeavyJobError) return failure(command, error.code, error.message, null, error.context);
      const code = errorCode(error);
      return failure(command, code === 'WTM_JOB_SOURCE_CHANGED' ? code : 'WTM_CONFIG_INVALID', 'Job request could not be completed safely.', null, { reason: code });
    }
  }

  #schedule(delay: number): void {
    if (this.#closed || !this.#started || this.#timer !== null) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush().catch(() => {}); }, delay);
    this.#timer.unref();
  }

  #process(job: HeavyJobRecord): ManagedProcessRecord | null {
    return this.#options.supervisor.list(job.worktreeId).find((record) => record.id === job.processId
      || job.processId === null && record.taskName === `job-${job.jobId}`) ?? null;
  }

  #memory(): JobMemoryAdmission | undefined {
    if (this.#options.memory === undefined) return undefined;
    let sample: HostJobMemory;
    try { sample = sanitizeHostJobMemory((this.#options.readMemory ?? readHostJobMemory)()); }
    catch { sample = { availableBytes: null, totalBytes: null }; }
    return { ...this.#options.memory, ...sample };
  }

  async #launch(job: HeavyJobRecord): Promise<void> {
    let attemptedSpawn = false;
    try {
      const task = await this.#options.resolveTask(job.worktreePath, job.taskName);
      if (task.worktreeId !== job.worktreeId || task.repositoryId !== job.repositoryId || task.worktreePath !== job.worktreePath
        || commandFingerprint(task) !== job.commandFingerprint) throw new HeavyJobError('WTM_JOB_SOURCE_CHANGED', 'Task changed while queued.');
      if ((await this.#snapshot(job.worktreePath)).fingerprint !== job.sourceFingerprint) throw new HeavyJobError('WTM_JOB_SOURCE_CHANGED', 'Sources changed while queued.');
      if (this.#now().getTime() >= Date.parse(job.startedAt!) + job.timeoutMs) {
        this.#options.store.requestCancellation(job.jobId, this.#options.scope, 'TIMED_OUT', this.#now().toISOString());
        await this.#finish(job, 'TIMED_OUT', null, null, 'TIMEOUT_BEFORE_START');
        return;
      }
      if (this.#closed || this.get(job.jobId).stopReason !== null) {
        await this.#finish(job, this.get(job.jobId).stopReason ?? 'INTERRUPTED', null, null, 'CANCELLED_BEFORE_START');
        return;
      }
      attemptedSpawn = true;
      await this.#options.supervisor.start({
        worktreeId: job.worktreeId, taskName: `job-${job.jobId}`, argv: task.argv,
        cwd: task.cwd, shell: task.shell, env: task.env,
        logRotationBytes: 1024 * 1024, logRetainedFiles: 1,
        deadlineAt: Date.parse(job.startedAt!) + job.timeoutMs,
        onRecorded: (record) => {
          if (!this.#options.store.bindProcess(job.jobId, record.id)) throw new Error('JOB_PROCESS_BIND_FAILED');
        },
        onSpawned: (pid) => {
          if (!this.#options.store.bindAnchor(job.jobId, pid)) throw new Error('JOB_ANCHOR_BIND_FAILED');
        },
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'context' in error) {
        const context = error.context as { reason?: string; anchorPid?: number } | undefined;
        if (context?.reason === 'UNCONFIRMED_ANCHOR_CLEANUP' && context.anchorPid !== undefined) {
          this.#options.store.bindAnchor(job.jobId, context.anchorPid);
        }
      }
      const current = this.get(job.jobId);
      // A failed start can own an anchor requiring cleanup. Its slot survives the failure.
      const context = typeof error === 'object' && error !== null && 'context' in error ? error.context as { spawnOutcome?: string; reason?: string } : null;
      const provedNoProcess = context?.spawnOutcome === 'not-started' || context?.spawnOutcome === 'cleaned';
      const stopReason = context?.reason === 'ANCHOR_DEADLINE_EXPIRED' ? 'TIMED_OUT' : 'INTERRUPTED';
      if (this.#process(current) !== null || current.anchorPid !== null || attemptedSpawn && !provedNoProcess) {
        this.#options.store.requestCancellation(job.jobId, this.#options.scope, stopReason, this.#now().toISOString());
        this.#options.store.setError(job.jobId, current.anchorPid === null && current.processId === null && attemptedSpawn && !provedNoProcess ? 'SPAWN_OWNERSHIP_UNCONFIRMED' : errorCode(error));
      } else await this.#finish(job, stopReason, null, null, errorCode(error));
    }
  }

  async #reconcile(initial: HeavyJobRecord): Promise<void> {
    let job = this.get(initial.jobId);
    const process = this.#process(job);
    if (process === null) {
      // The supervisor cannot send GO before onRecorded bound a durable process identity.
      if (job.error === 'SPAWN_OWNERSHIP_UNCONFIRMED') return;
      if (job.anchorPid !== null && (await this.#options.inspectGroup(job.anchorPid)).status !== 'absent') {
        this.#options.store.setError(job.jobId, 'UNCONFIRMED_ANCHOR_CLEANUP');
      } else if (job.processId === null) await this.#finish(job, job.stopReason ?? 'INTERRUPTED', null, null, job.error ?? 'DAEMON_INTERRUPTED_BEFORE_LAUNCH');
      else this.#options.store.setError(job.jobId, 'PROCESS_RECORD_MISSING');
      return;
    }
    if (job.processId === null) {
      this.#options.store.bindProcess(job.jobId, process.id);
      job = this.get(job.jobId);
    }
    let completion: ManagedProcessCompletion | null = null;
    let completionUnreadable = job.error === 'COMPLETION_UNREADABLE';
    try {
      completion = await this.#options.logs?.readCompletion(process.stdoutPath, process.pid) ?? null;
      if (completion !== null) completionUnreadable = false;
    } catch { completionUnreadable = true; this.#options.store.setError(job.jobId, 'COMPLETION_UNREADABLE'); }
    // The anchor exit event can win the race with its refusal message. Its durable
    // completion is stronger evidence than that provisional control-channel failure.
    if (completion?.timedOut === true) job = this.#options.store.confirmTimeout(job.jobId, this.#options.scope);
    const observed = this.#exits.get(job.jobId);
    const completedAt = completion?.completedAt ?? observed?.exitedAt;
    const completionTime = completedAt === undefined ? this.#now().getTime() : Date.parse(completedAt);
    if (job.stopReason === null && job.startedAt !== null && completionTime >= Date.parse(job.startedAt) + job.timeoutMs) {
      job = this.#options.store.requestCancellation(job.jobId, this.#options.scope, 'TIMED_OUT', this.#now().toISOString());
    }
    const recovering = this.#recovering.has(job.jobId);
    if (job.stopReason === null && recovering && completion === null) {
      job = this.#options.store.requestCancellation(job.jobId, this.#options.scope, 'INTERRUPTED', this.#now().toISOString());
    }
    if (completion === null && observed === undefined && job.stopReason === null && !completionUnreadable) return;
    let group = await this.#options.inspectGroup(process.pgid);
    if (group.status !== 'absent' && job.stopReason !== null) {
      const last = this.#stopAttempts.get(job.jobId) ?? -Infinity;
      if (this.#now().getTime() - last >= 5000) {
        this.#stopAttempts.set(job.jobId, this.#now().getTime());
        try { await this.#options.supervisor.stopRecord(process); }
        catch { this.#options.store.setError(job.jobId, 'PROCESS_CLEANUP_UNCONFIRMED'); }
        group = await this.#options.inspectGroup(process.pgid);
      }
    }
    if (group.status !== 'absent') {
      this.#options.store.setError(job.jobId, completionUnreadable ? 'COMPLETION_UNREADABLE'
        : group.status === 'failed' ? 'PROCESS_INSPECTION_FAILED' : 'PROCESS_TREE_STILL_RUNNING');
      return;
    }
    // Exit callbacks share the supervisor lifecycle lock with stop confirmation. Drain
    // that confirmation before selecting evidence which may have arrived while awaiting it.
    await this.#options.supervisor.confirmStopped?.(process);
    // Stopping and group inspection yield while the anchor can publish its final task
    // outcome (including replacement of a provisional deadline marker). Read that evidence
    // after confirmed group absence, before making the immutable terminal record.
    try {
      const finalCompletion = await this.#options.logs?.readCompletion(process.stdoutPath, process.pid) ?? null;
      if (finalCompletion !== null) { completion = finalCompletion; completionUnreadable = false; }
    } catch { completionUnreadable = true; this.#options.store.setError(job.jobId, 'COMPLETION_UNREADABLE'); }
    if (completion?.timedOut === true) job = this.#options.store.confirmTimeout(job.jobId, this.#options.scope);
    const finalObserved = this.#exits.get(job.jobId);
    // Null is task evidence too: a signal-ended child has no numeric exit code, and a
    // successful child has no signal. The anchor's separate outcome cannot fill either field.
    const exitCode = completion !== null ? completion.exitCode : finalObserved?.exitCode ?? null;
    const signal = completion !== null ? completion.signal : finalObserved?.signal ?? null;
    // A missing marker permits the observed fallback; a marker that failed authentication
    // or parsing does not. Only a later valid completion clears that failure, even across polls.
    const state = job.stopReason ?? (completionUnreadable ? 'INTERRUPTED' : completion?.logFailed === true ? 'FAILED'
      : exitCode === 0 && signal === null ? 'SUCCEEDED' : completion !== null || finalObserved !== undefined ? 'FAILED' : 'INTERRUPTED');
    await this.#finish(job, state, exitCode, signal, job.stopReason === 'CANCELLED' ? 'USER_CANCELLED'
      : job.stopReason === 'TIMED_OUT' ? 'TIMEOUT' : job.stopReason === 'INTERRUPTED' ? job.error ?? 'DAEMON_INTERRUPTED'
        : completionUnreadable ? 'COMPLETION_UNREADABLE' : completion?.logFailed === true ? 'LOG_WRITE_FAILED' : null);
  }

  async #sourceValidity(job: HeavyJobRecord): Promise<SourceValidity> {
    try {
      const current = await this.#snapshot(job.worktreePath);
      if (current.fingerprint !== job.sourceFingerprint || job.sourceValidity === 'CHANGED') return 'CHANGED';
      const task = await this.#options.resolveTask(job.worktreePath, job.taskName);
      return commandFingerprint(task) === job.commandFingerprint ? 'UNCHANGED' : 'CHANGED';
    } catch { return 'UNKNOWN'; }
  }

  async #finish(job: HeavyJobRecord, state: Exclude<HeavyJobRecord['state'], 'QUEUED' | 'RUNNING'>, exitCode: number | null, signal: string | null, error: string | null): Promise<void> {
    const sourceValidity = await this.#sourceValidity(job);
    this.#options.store.finish(job.jobId, { state, exitCode, signal, error, sourceValidity, now: this.#now().toISOString() });
    this.#recovering.delete(job.jobId); this.#exits.delete(job.jobId); this.#stopAttempts.delete(job.jobId);
  }

  async #prune(): Promise<void> {
    for (const job of this.#options.store.prunable(this.#options.scope, this.#now().toISOString())) {
      const record = this.#process(job);
      if (record !== null && (record.cleanupRequired || ['STARTING', 'RUNNING', 'STOPPING'].includes(record.state))) continue;
      try {
        await this.#options.logs?.removeJob(job.worktreeId, job.jobId);
        this.#options.store.deleteFinished(job.jobId);
      } catch (error) { this.#options.onError?.(error); }
    }
  }
}

function commandFingerprint(task: ResolvedHeavyJob): string {
  const env = Object.entries(task.env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  const inputs: unknown[] = [task.argv, task.cwd, task.shell, env, task.timeoutMs];
  // Preserve legacy fingerprints when memory admission was not configured.
  if (task.memoryEstimateBytes != null) inputs.push({ memoryEstimateBytes: task.memoryEstimateBytes });
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

function publicJob(job: HeavyJobRecord, waiting?: ReadonlyMap<string, JobWaitingReason>) {
  return {
    jobId: job.jobId, state: job.state, taskName: job.taskName, workspaceId: job.workspaceId,
    repositoryId: job.repositoryId, worktreeId: job.worktreeId, worktreePath: job.worktreePath,
    slotHeld: job.slotHeld, processId: job.processId, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt, timeoutMs: job.timeoutMs, exitCode: job.exitCode, signal: job.signal,
    memoryEstimateBytes: job.memoryEstimateBytes,
    error: job.error, stopReason: job.stopReason, sourceValidity: job.sourceValidity,
    waitingReason: job.state === 'QUEUED' ? waiting?.get(job.jobId) ?? 'dispatch_pending' : null,
    sourceFingerprint: job.sourceFingerprint,
    commandFingerprint: job.commandFingerprint, sourceScope: 'git-tracked-and-untracked',
  };
}

function errorCode(error: unknown): string {
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? error.code : error instanceof Error ? error.message : '';
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'JOB_OPERATION_FAILED';
}
function tailLines(text: string, lines: number): string { return text.split('\n').slice(-lines - (text.endsWith('\n') ? 1 : 0)).join('\n'); }
function success(command: string, data: unknown): JsonEnvelope<unknown> { return { schemaVersion: 1, command, ok: true, data, warnings: [], errors: [], scope: { mode: 'global' } }; }
function failure(command: string, code: WtmErrorCode, message: string, data: unknown = null, context: Record<string, unknown> = {}): JsonEnvelope<unknown> { return { schemaVersion: 1, command, ok: false, data, warnings: [], errors: [{ code, message, severity: 'error', context }], scope: { mode: 'global' } }; }
