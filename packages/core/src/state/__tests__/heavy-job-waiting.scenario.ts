import assert from 'node:assert/strict';
import { SQLiteStateStore } from '../sqlite-store';

const store = new SQLiteStateStore(':memory:');
const scope = 'waiting-host:user';
const time = '2026-09-09T00:00:00.000Z';
try {
  const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
  const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
  const trees = store.reconcileWorktrees(repository.id, ['/jobs', '/jobs-two', '/jobs-three'].map((path) => ({
    path, head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null,
  }))).discovered;
  function enqueue(index: number, key: string, jobScope = scope) {
    const tree = trees[index]!;
    return store.jobs.enqueue({
      scope: jobScope, repositoryId: repository.id, workspaceId: workspace.id, worktreeId: tree.id,
      worktreePath: tree.path, taskName: 'check', commandFingerprint: 'b'.repeat(64),
      sourceFingerprint: 'c'.repeat(64), timeoutMs: 1000, now: time, idempotencyKey: key,
    }).job;
  }
  const first = enqueue(0, 'first');
  const second = enqueue(0, 'second');
  const third = enqueue(1, 'third');
  const fourth = enqueue(2, 'fourth');
  const before = store.jobs.active(scope);
  assert.deepEqual([...store.jobs.waitingReasons(scope, 2)], [
    [first.jobId, 'dispatch_pending'], [second.jobId, 'fifo'], [third.jobId, 'fifo'], [fourth.jobId, 'fifo'],
  ]);
  assert.deepEqual(store.jobs.active(scope), before, 'diagnostics must never claim a job or mutate its state');
  assert.equal(store.jobs.claim(scope, 1, time)?.jobId, first.jobId);
  assert.deepEqual([...store.jobs.waitingReasons(scope, 1)], [
    [second.jobId, 'concurrency'], [third.jobId, 'concurrency'], [fourth.jobId, 'concurrency'],
  ]);
  assert.deepEqual([...store.jobs.waitingReasons(scope, 2)], [
    [second.jobId, 'worktree_busy'], [third.jobId, 'fifo'], [fourth.jobId, 'fifo'],
  ]);
  assert.equal(store.jobs.claim(scope, 2, time), null, 'the reason and actual FIFO claim must agree');
  store.jobs.requestCancellation(first.jobId, scope, 'CANCELLED', time);
  assert.equal(store.jobs.waitingReasons(scope, 1).get(second.jobId), 'concurrency', 'cancellation does not free an unconfirmed slot');
  assert.equal(store.jobs.waitingReasons(scope, 2).get(second.jobId), 'worktree_busy');
  store.jobs.finish(first.jobId, { state: 'CANCELLED', exitCode: null, signal: null, error: 'USER_CANCELLED', sourceValidity: 'UNCHANGED', now: time });
  assert.equal(store.jobs.waitingReasons(scope, 2).get(second.jobId), 'dispatch_pending');
  store.jobs.requestCancellation(second.jobId, scope, 'CANCELLED', time);
  assert.deepEqual([...store.jobs.waitingReasons(scope, 2)], [[third.jobId, 'dispatch_pending'], [fourth.jobId, 'fifo']]);
  assert.equal(store.jobs.claim(scope, 2, time)?.jobId, third.jobId);
  assert.equal(store.jobs.waitingReasons(scope, 2).get(fourth.jobId), 'dispatch_pending');
  assert.equal(store.jobs.claim(scope, 2, time)?.jobId, fourth.jobId);
  assert.equal(store.jobs.waitingReasons(scope, 2).size, 0, 'running and terminal records have no waiting reason');

  // Keep the pre-existing same-worktree guard across scopes while capacity stays scoped.
  const otherScope = 'foreign-host:user';
  const foreign = enqueue(0, 'foreign', otherScope);
  assert.equal(store.jobs.claim(otherScope, 1, time)?.jobId, foreign.jobId);
  const blocked = enqueue(0, 'cross-scope');
  assert.deepEqual([...store.jobs.waitingReasons(scope, 3)], [[blocked.jobId, 'worktree_busy']]);
  assert.equal(store.jobs.claim(scope, 3, time), null);
  assert.equal(store.jobs.waitingReasons('unrelated', 1).size, 0);
  assert.throws(() => store.jobs.waitingReasons(scope, 0), /concurrency/i);
  assert.throws(() => store.jobs.waitingReasons(scope, 1.5), /concurrency/i);
  console.log(JSON.stringify({ ok: true }));
} finally { store.close(); }
