import assert from 'node:assert/strict';
import { SQLiteStateStore } from '../sqlite-store';
import type { HeavyJobFinishInput } from '../jobs';

const mode = process.argv[2];
const store = new SQLiteStateStore(':memory:');
const time = '2026-09-09T00:00:00.000Z';
const scope = 'finalization-host:user';
const completed: HeavyJobFinishInput = {
  state: 'SUCCEEDED', exitCode: 0, signal: null, error: null, sourceValidity: 'UNCHANGED', now: time,
};

try {
  const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
  const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
  const worktree = store.reconcileWorktrees(repo.id, [{ path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }]).discovered[0];
  assert.ok(worktree);
  const { job } = store.jobs.enqueue({
    scope, repositoryId: repo.id, workspaceId: workspace.id, worktreeId: worktree.id,
    worktreePath: worktree.path, taskName: 'check', commandFingerprint: 'b'.repeat(64),
    sourceFingerprint: 'c'.repeat(64), timeoutMs: 1000, now: time, idempotencyKey: 'finalization',
  });
  if (mode !== 'queued-cancellation') assert.equal(store.jobs.claim(scope, 1, time)?.jobId, job.jobId);

  if (mode === 'cancellation') {
    store.jobs.requestCancellation(job.jobId, scope, 'CANCELLED', time);
    const final = store.jobs.finish(job.jobId, completed);
    assert.equal(final.state, 'CANCELLED', 'durably accepted cancellation must beat stale success');
    assert.equal(final.stopReason, 'CANCELLED');
    assert.equal(final.error, 'USER_CANCELLED');
    assert.equal(final.exitCode, 0, 'cancellation must preserve observed completion evidence');
    assert.equal(final.sourceValidity, 'UNCHANGED');
    assert.equal(final.slotHeld, false);
  } else if (mode === 'timeout') {
    store.jobs.requestCancellation(job.jobId, scope, 'INTERRUPTED', time);
    store.jobs.confirmTimeout(job.jobId, scope);
    const final = store.jobs.finish(job.jobId, { ...completed, state: 'INTERRUPTED', exitCode: 9, signal: 'SIGTERM', error: 'HANDSHAKE_FAILED', sourceValidity: 'CHANGED' });
    assert.equal(final.state, 'TIMED_OUT', 'confirmed timeout must beat provisional interruption');
    assert.equal(final.stopReason, 'TIMED_OUT');
    assert.equal(final.error, 'TIMEOUT');
    assert.equal(final.exitCode, 9);
    assert.equal(final.signal, 'SIGTERM');
    assert.equal(final.sourceValidity, 'CHANGED');
  } else if (mode === 'cancelled-timeout') {
    store.jobs.requestCancellation(job.jobId, scope, 'CANCELLED', time);
    store.jobs.confirmTimeout(job.jobId, scope);
    const final = store.jobs.finish(job.jobId, { ...completed, state: 'TIMED_OUT', error: 'TIMEOUT' });
    assert.equal(final.state, 'CANCELLED', 'timeout evidence cannot replace explicit cancellation');
    assert.equal(final.stopReason, 'CANCELLED');
    assert.equal(final.error, 'USER_CANCELLED');
  } else if (mode === 'interruption') {
    store.jobs.requestCancellation(job.jobId, scope, 'INTERRUPTED', time);
    store.jobs.setError(job.jobId, 'PROCESS_IDENTITY_MISMATCH');
    const final = store.jobs.finish(job.jobId, completed);
    assert.equal(final.state, 'INTERRUPTED');
    assert.equal(final.error, 'PROCESS_IDENTITY_MISMATCH', 'durable interruption diagnostics must survive stale success');
  } else if (mode === 'specific-timeout') {
    store.jobs.requestCancellation(job.jobId, scope, 'TIMED_OUT', time);
    const final = store.jobs.finish(job.jobId, { ...completed, state: 'TIMED_OUT', error: 'TIMEOUT_BEFORE_START' });
    assert.equal(final.state, 'TIMED_OUT');
    assert.equal(final.error, 'TIMEOUT_BEFORE_START');
  } else if (mode === 'queued-cancellation') {
    const cancelled = store.jobs.requestCancellation(job.jobId, scope, 'CANCELLED', time);
    assert.equal(cancelled.state, 'CANCELLED');
    assert.deepEqual(store.jobs.finish(job.jobId, completed), cancelled, 'late finish must not rewrite queued cancellation');
    assert.equal(store.jobs.claim(scope, 1, time), null);
  } else if (mode === 'terminal-immutable') {
    const final = store.jobs.finish(job.jobId, completed);
    assert.deepEqual(store.jobs.requestCancellation(job.jobId, scope, 'CANCELLED', time), final, 'cancellation after finalization is a no-op');
    assert.deepEqual(store.jobs.confirmTimeout(job.jobId, scope), final);
    assert.deepEqual(store.jobs.finish(job.jobId, { ...completed, state: 'FAILED', exitCode: 17, signal: 'SIGKILL', error: 'LATE_ERROR', sourceValidity: 'CHANGED', now: '2026-09-09T00:01:00.000Z' }), final, 'terminal results are immutable');
  } else throw new Error(`Unknown finalization scenario: ${mode}`);

  console.log(JSON.stringify({ ok: true }));
} finally { store.close(); }
