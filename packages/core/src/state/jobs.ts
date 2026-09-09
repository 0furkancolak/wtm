import type { JobState, JobWaitingReason, SourceValidity } from '@wtm/protocol';

export interface HeavyJobRecord {
  jobId: string;
  sequence: number;
  scope: string;
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
  taskName: string;
  idempotencyKey: string;
  commandFingerprint: string;
  sourceFingerprint: string;
  timeoutMs: number;
  state: JobState;
  slotHeld: boolean;
  processId: string | null;
  anchorPid: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  sourceValidity: SourceValidity;
  stopReason: 'CANCELLED' | 'TIMED_OUT' | 'INTERRUPTED' | null;
}

export interface HeavyJobEnqueueInput {
  scope: string;
  workspaceId: string;
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
  taskName: string;
  idempotencyKey: string;
  commandFingerprint: string;
  sourceFingerprint: string;
  timeoutMs: number;
  now: string;
}

export interface HeavyJobFinishInput {
  state: Exclude<JobState, 'QUEUED' | 'RUNNING'>;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  sourceValidity: SourceValidity;
  now: string;
}

export interface HeavyJobStore {
  assertScope(scope: string): void;
  enqueue(input: HeavyJobEnqueueInput): { job: HeavyJobRecord; reused: boolean };
  get(jobId: string, scope: string): HeavyJobRecord | null;
  list(scope: string, limit?: number): HeavyJobRecord[];
  active(scope: string): HeavyJobRecord[];
  /** Current FIFO/capacity observations for queued jobs only; reading does not dispatch. */
  waitingReasons(scope: string, maxConcurrent: number): ReadonlyMap<string, JobWaitingReason>;
  claim(scope: string, maxConcurrent: number, now: string): HeavyJobRecord | null;
  bindProcess(jobId: string, processId: string): boolean;
  bindAnchor(jobId: string, pid: number): boolean;
  requestCancellation(jobId: string, scope: string, reason: 'CANCELLED' | 'TIMED_OUT' | 'INTERRUPTED', now: string): HeavyJobRecord;
  /** Authenticated timeout evidence may replace a provisional interruption, never explicit cancellation. */
  confirmTimeout(jobId: string, scope: string): HeavyJobRecord;
  /**
   * Caller must establish process-group absence before releasing an occupied slot.
   * Finalization atomically preserves an already accepted stop reason and numeric exit
   * evidence. A stop request after finalization cannot rewrite the terminal result.
   */
  finish(jobId: string, input: HeavyJobFinishInput): HeavyJobRecord;
  setError(jobId: string, error: string): void;
  prunable(scope: string, now: string): HeavyJobRecord[];
  deleteFinished(jobId: string): boolean;
}

export class HeavyJobError extends Error {
  readonly severity = 'error' as const;
  constructor(
    readonly code: 'WTM_JOB_NOT_FOUND' | 'WTM_JOB_QUEUE_FULL' | 'WTM_JOB_IDEMPOTENCY_CONFLICT'
      | 'WTM_JOB_NOT_QUEUEABLE' | 'WTM_JOB_NOT_COMPLETE' | 'WTM_JOB_UNSUCCESSFUL'
      | 'WTM_JOB_SOURCE_CHANGED' | 'WTM_OPERATION_CONFLICT',
    message: string,
    readonly context: Record<string, unknown> = {},
  ) { super(message); this.name = 'HeavyJobError'; }
}

export const maxPendingHeavyJobs = 128;
export const maxRetainedHeavyJobs = 256;
export const heavyJobRetentionMs = 7 * 24 * 60 * 60 * 1000;
