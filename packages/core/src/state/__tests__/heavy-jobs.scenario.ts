import assert from 'node:assert/strict';
import { SQLiteStateStore } from '../sqlite-store';

const store = new SQLiteStateStore(':memory:');
const time = '2026-09-09T00:00:00.000Z';
try {
  const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
  const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
  const worktree = store.reconcileWorktrees(repo.id, [{ path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }]).discovered[0];
  assert.ok(worktree);
  const input = {
    scope: 'host-a:user', repositoryId: repo.id, workspaceId: workspace.id, worktreeId: worktree.id,
    worktreePath: worktree.path, taskName: 'check', commandFingerprint: 'b'.repeat(64),
    sourceFingerprint: 'c'.repeat(64), timeoutMs: 1_000, now: time,
  };
  const first = store.jobs.enqueue({ ...input, idempotencyKey: 'first' });
  const second = store.jobs.enqueue({ ...input, idempotencyKey: 'second' });
  assert.equal(store.jobs.enqueue({ ...input, idempotencyKey: 'first' }).job.jobId, first.job.jobId);
  assert.equal(store.jobs.enqueue({ ...input, idempotencyKey: 'first' }).reused, true);
  assert.throws(() => store.jobs.enqueue({ ...input, idempotencyKey: 'first', commandFingerprint: 'd'.repeat(64) }), /different request/);
  assert.throws(() => store.acquireRepositoryOperationLease({ repositoryId: repo.id, operation: 'remove', token: 'remove', pid: 10, processStartTime: 'start', hostId: 'host-a', ttlMs: 1000 }, time), /pending or running jobs/);
  assert.throws(() => store.forgetRepository(repo.id), /pending or running jobs/);
  const claimed = store.jobs.claim(input.scope, 1, time);
  assert.equal(claimed?.jobId, first.job.jobId);
  assert.equal(store.jobs.claim(input.scope, 1, time), null);
  assert.equal(store.jobs.claim(input.scope, 2, time), null, 'same worktree must not overlap');
  store.jobs.requestCancellation(claimed!.jobId, input.scope, 'CANCELLED', time);
  assert.equal(store.jobs.get(claimed!.jobId, input.scope)?.slotHeld, true);
  store.jobs.finish(claimed!.jobId, { state: 'CANCELLED', exitCode: null, signal: null, error: 'USER_CANCELLED', sourceValidity: 'UNCHANGED', now: time });
  assert.equal(store.jobs.claim(input.scope, 1, time)?.jobId, second.job.jobId);
  store.jobs.finish(second.job.jobId, { state: 'FAILED', exitCode: 7, signal: null, error: null, sourceValidity: 'UNCHANGED', now: time });
  assert.equal(store.jobs.get(second.job.jobId, input.scope)?.exitCode, 7);
  assert.equal(store.jobs.get(second.job.jobId, 'host-b:user'), null);
  const queued = store.jobs.enqueue({ ...input, idempotencyKey: 'queued-cancel' });
  store.jobs.requestCancellation(queued.job.jobId, input.scope, 'CANCELLED', time);
  assert.equal(store.jobs.get(queued.job.jobId, input.scope)?.state, 'CANCELLED');
  const lease = store.acquireRepositoryOperationLease({ repositoryId: repo.id, operation: 'remove', token: 'remove', pid: 10, processStartTime: 'start', hostId: 'host-a', ttlMs: 1000 }, time);
  assert.equal(lease.outcome, 'acquired');
  assert.throws(() => store.jobs.enqueue({ ...input, idempotencyKey: 'during-remove' }), /repository operation/);
  assert.equal(store.jobs.prunable(input.scope, '2027-01-01T00:00:00.000Z').length, 3);
  console.log(JSON.stringify({ ok: true }));
} finally { store.close(); }
