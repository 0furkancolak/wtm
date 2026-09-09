import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database';
import { jobWaitingReasons, type JobSchedulingEntry } from './job-scheduling';
import {
  HeavyJobError, heavyJobRetentionMs, maxPendingHeavyJobs, maxRetainedHeavyJobs,
  type HeavyJobEnqueueInput, type HeavyJobFinishInput, type HeavyJobRecord, type HeavyJobStore,
} from './jobs';

type Row = Record<string, string | number | null>;

function record(row: Row): HeavyJobRecord {
  return {
    jobId: String(row.job_id), sequence: Number(row.sequence), scope: String(row.scope),
    workspaceId: String(row.workspace_id), repositoryId: String(row.repository_id), worktreeId: String(row.worktree_id),
    worktreePath: String(row.worktree_path), taskName: String(row.task_name), idempotencyKey: String(row.idempotency_key),
    commandFingerprint: String(row.command_fingerprint), sourceFingerprint: String(row.source_fingerprint), timeoutMs: Number(row.timeout_ms),
    state: row.state as HeavyJobRecord['state'], slotHeld: row.slot_held === 1, processId: row.process_id as string | null, anchorPid: row.anchor_pid as number | null,
    createdAt: String(row.created_at), startedAt: row.started_at as string | null, finishedAt: row.finished_at as string | null,
    exitCode: row.exit_code as number | null, signal: row.signal as string | null, error: row.error as string | null,
    sourceValidity: row.source_validity as HeavyJobRecord['sourceValidity'], stopReason: row.stop_reason as HeavyJobRecord['stopReason'],
  };
}

/** Both the queue and the operation lease call this inside the store's BEGIN IMMEDIATE. */
export function assertNoHeavyJobs(database: SqliteDatabase, repositoryId: string): void {
  const row = database.prepare(`SELECT job_id FROM heavy_jobs WHERE repository_id = ? AND (state = 'QUEUED' OR slot_held = 1) LIMIT 1`).get(repositoryId) as Row | undefined;
  if (row !== undefined) throw new HeavyJobError('WTM_OPERATION_CONFLICT', 'Repository has pending or running jobs; cancel them before cleanup.', { repositoryId, jobId: row.job_id });
}

export function createHeavyJobStore(database: SqliteDatabase): HeavyJobStore {
  const transaction = <T>(body: () => T): T => database.transaction(body).immediate();
  const schedulingSnapshot = (scope: string): JobSchedulingEntry[] => (
    database.prepare(`SELECT job.job_id, job.state, job.slot_held,
      EXISTS (SELECT 1 FROM heavy_jobs occupied WHERE occupied.worktree_id = job.worktree_id AND occupied.slot_held = 1) AS worktree_busy
      FROM heavy_jobs job WHERE job.scope = ? AND (job.state = 'QUEUED' OR job.slot_held = 1)
      ORDER BY job.sequence`).all(scope) as Row[]
  ).map((row) => ({
    jobId: String(row.job_id), state: row.state as JobSchedulingEntry['state'],
    slotHeld: row.slot_held === 1, worktreeBusy: row.worktree_busy === 1,
  }));
  const getById = (jobId: string): HeavyJobRecord => {
    const row = database.prepare('SELECT * FROM heavy_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
    if (row === undefined) throw new HeavyJobError('WTM_JOB_NOT_FOUND', 'Job was not found.', { jobId });
    return record(row);
  };
  const assertRegistered = (input: Pick<HeavyJobEnqueueInput, 'repositoryId' | 'worktreeId' | 'worktreePath'>): void => {
    const row = database.prepare(`SELECT path, state FROM worktrees WHERE id = ? AND repository_id = ?`).get(input.worktreeId, input.repositoryId) as Row | undefined;
    if (row === undefined || row.path !== input.worktreePath || ['CLEANING', 'DEGRADED_CLEANUP', 'REMOVED', 'ORPHANED'].includes(String(row.state))) {
      throw new HeavyJobError('WTM_OPERATION_CONFLICT', 'Worktree is unavailable or being removed.', { worktreeId: input.worktreeId });
    }
    if (database.prepare('SELECT 1 FROM repository_operation_leases WHERE repository_id = ? LIMIT 1').get(input.repositoryId) !== undefined) {
      throw new HeavyJobError('WTM_OPERATION_CONFLICT', 'A repository operation prevents accepting or starting this job.', { repositoryId: input.repositoryId });
    }
  };
  return {
    assertScope(scope) {
      transaction(() => {
        const owner = database.prepare('SELECT scope FROM heavy_job_state_owner WHERE singleton = 1').get() as { scope: string } | undefined;
        if (owner !== undefined && owner.scope !== scope) throw new HeavyJobError('WTM_JOB_NOT_QUEUEABLE', 'This state database belongs to another host or user; use a host-local state directory.');
        if (owner === undefined) {
          // Legacy state has no machine identity to prove retrospectively. Its first upgrade
          // requires the existing host-local state assumption; afterward every recovery is bound.
          // Refusing old RUNNING rows here would prevent starting the daemon needed to stop them.
          database.prepare('INSERT INTO heavy_job_state_owner(singleton, scope) VALUES (1, ?)').run(scope);
        }
      });
    },
    enqueue(input) {
      if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.idempotencyKey.length < 1) throw new TypeError('Invalid heavy job admission');
      return transaction(() => {
        const existing = database.prepare('SELECT * FROM heavy_jobs WHERE scope = ? AND idempotency_key = ?').get(input.scope, input.idempotencyKey) as Row | undefined;
        if (existing !== undefined) {
          const job = record(existing);
          if (job.worktreeId !== input.worktreeId || job.taskName !== input.taskName || job.commandFingerprint !== input.commandFingerprint
            || job.sourceFingerprint !== input.sourceFingerprint || job.timeoutMs !== input.timeoutMs) {
            throw new HeavyJobError('WTM_JOB_IDEMPOTENCY_CONFLICT', 'Idempotency key already identifies a different request.', { jobId: job.jobId });
          }
          return { job, reused: true };
        }
        assertRegistered(input);
        const count = database.prepare("SELECT COUNT(*) AS count FROM heavy_jobs WHERE scope = ? AND (state = 'QUEUED' OR slot_held = 1)").get(input.scope) as { count: number };
        const total = database.prepare('SELECT COUNT(*) AS count FROM heavy_jobs WHERE scope = ?').get(input.scope) as { count: number };
        if (count.count >= maxPendingHeavyJobs || total.count >= maxPendingHeavyJobs + maxRetainedHeavyJobs) {
          throw new HeavyJobError('WTM_JOB_QUEUE_FULL', 'Heavy job queue or retained history is full.', { maxPending: maxPendingHeavyJobs });
        }
        const jobId = randomUUID();
        database.prepare(`INSERT INTO heavy_jobs (job_id, scope, workspace_id, repository_id, worktree_id, worktree_path, task_name, idempotency_key, command_fingerprint, source_fingerprint, timeout_ms, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)`).run(jobId, input.scope, input.workspaceId, input.repositoryId, input.worktreeId, input.worktreePath, input.taskName, input.idempotencyKey, input.commandFingerprint, input.sourceFingerprint, input.timeoutMs, input.now);
        return { job: getById(jobId), reused: false };
      });
    },
    get(jobId, scope) {
      const row = database.prepare('SELECT * FROM heavy_jobs WHERE job_id = ? AND scope = ?').get(jobId, scope) as Row | undefined;
      return row === undefined ? null : record(row);
    },
    list(scope, limit = 50) {
      return (database.prepare('SELECT * FROM heavy_jobs WHERE scope = ? ORDER BY sequence DESC LIMIT ?').all(scope, Math.min(100, Math.max(1, limit))) as Row[]).map(record);
    },
    active(scope) {
      return (database.prepare("SELECT * FROM heavy_jobs WHERE scope = ? AND (state = 'QUEUED' OR slot_held = 1) ORDER BY sequence").all(scope) as Row[]).map(record);
    },
    waitingReasons(scope, maxConcurrent) {
      return jobWaitingReasons(schedulingSnapshot(scope), maxConcurrent);
    },
    claim(scope, maxConcurrent, now) {
      if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('Invalid concurrency limit');
      return transaction(() => {
        const reasons = jobWaitingReasons(schedulingSnapshot(scope), maxConcurrent);
        const next = reasons.entries().next().value;
        if (next?.[1] !== 'dispatch_pending') return null;
        const job = getById(next[0]);
        try { assertRegistered(job); }
        catch (error) {
          if (!(error instanceof HeavyJobError)) throw error;
          database.prepare("UPDATE heavy_jobs SET state = 'INTERRUPTED', finished_at = ?, error = 'WORKTREE_UNAVAILABLE' WHERE job_id = ?").run(now, job.jobId);
          return null;
        }
        database.prepare("UPDATE heavy_jobs SET state = 'RUNNING', slot_held = 1, started_at = ? WHERE job_id = ? AND state = 'QUEUED'").run(now, job.jobId);
        return getById(job.jobId);
      });
    },
    bindProcess(jobId, processId) {
      return database.prepare("UPDATE heavy_jobs SET process_id = ? WHERE job_id = ? AND state = 'RUNNING' AND slot_held = 1 AND process_id IS NULL").run(processId, jobId).changes === 1;
    },
    bindAnchor(jobId, pid) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Invalid job anchor PID');
      return database.prepare("UPDATE heavy_jobs SET anchor_pid = ? WHERE job_id = ? AND state = 'RUNNING' AND slot_held = 1 AND anchor_pid IS NULL").run(pid, jobId).changes === 1;
    },
    requestCancellation(jobId, scope, reason, now) {
      return transaction(() => {
        const job = getById(jobId);
        if (job.scope !== scope) throw new HeavyJobError('WTM_JOB_NOT_FOUND', 'Job was not found.', { jobId });
        if (job.state === 'QUEUED') database.prepare('UPDATE heavy_jobs SET state = ?, stop_reason = ?, error = ?, finished_at = ? WHERE job_id = ?').run(reason, reason, reason === 'CANCELLED' ? 'USER_CANCELLED' : reason, now, jobId);
        else if (job.slotHeld && job.stopReason === null) database.prepare('UPDATE heavy_jobs SET stop_reason = ? WHERE job_id = ?').run(reason, jobId);
        return getById(jobId);
      });
    },
    confirmTimeout(jobId, scope) {
      return transaction(() => {
        const job = getById(jobId);
        if (job.scope !== scope) throw new HeavyJobError('WTM_JOB_NOT_FOUND', 'Job was not found.', { jobId });
        database.prepare("UPDATE heavy_jobs SET stop_reason = 'TIMED_OUT' WHERE job_id = ? AND scope = ? AND state = 'RUNNING' AND slot_held = 1 AND (stop_reason IS NULL OR stop_reason = 'INTERRUPTED')").run(jobId, scope);
        return getById(jobId);
      });
    },
    finish(jobId: string, input: HeavyJobFinishInput) {
      return transaction(() => {
        const job = getById(jobId);
        if (job.state !== 'QUEUED' && !job.slotHeld) return job;
        // Source verification can await after the scheduler chooses an outcome. A stop
        // request committed in that interval is authoritative at this final transaction.
        const state = job.stopReason ?? input.state;
        let error = input.error;
        if (job.stopReason === 'CANCELLED') error = 'USER_CANCELLED';
        else if (job.stopReason === 'TIMED_OUT') error = input.state === 'TIMED_OUT' ? input.error ?? 'TIMEOUT' : 'TIMEOUT';
        else if (job.stopReason === 'INTERRUPTED') error = (input.state === 'INTERRUPTED' ? input.error : null) ?? job.error ?? 'DAEMON_INTERRUPTED';
        database.prepare(`UPDATE heavy_jobs SET state = ?, slot_held = 0, finished_at = ?, exit_code = ?, signal = ?, error = ?, source_validity = ? WHERE job_id = ? AND (state = 'QUEUED' OR slot_held = 1)`).run(state, input.now, input.exitCode, input.signal, error, input.sourceValidity, jobId);
        return getById(jobId);
      });
    },
    setError(jobId, error) { database.prepare('UPDATE heavy_jobs SET error = ? WHERE job_id = ? AND slot_held = 1').run(error, jobId); },
    prunable(scope, now) {
      const cutoff = new Date(Date.parse(now) - heavyJobRetentionMs).toISOString();
      const rows = database.prepare("SELECT * FROM heavy_jobs WHERE scope = ? AND slot_held = 0 AND state != 'QUEUED' ORDER BY sequence DESC").all(scope) as Row[];
      return rows.map(record).filter((job, index) => index >= maxRetainedHeavyJobs || (job.finishedAt ?? job.createdAt) < cutoff);
    },
    deleteFinished(jobId) {
      return transaction(() => {
        const job = getById(jobId);
        if (job.slotHeld || job.state === 'QUEUED') return false;
        if (job.processId !== null && database.prepare("SELECT 1 FROM managed_processes WHERE id = ? AND (cleanup_required = 1 OR state IN ('STARTING', 'RUNNING', 'STOPPING'))").get(job.processId) !== undefined) return false;
        if (job.processId !== null) database.prepare('DELETE FROM managed_processes WHERE id = ? AND cleanup_required = 0 AND state NOT IN (\'STARTING\', \'RUNNING\', \'STOPPING\')').run(job.processId);
        return database.prepare('DELETE FROM heavy_jobs WHERE job_id = ?').run(jobId).changes === 1;
      });
    },
  };
}
