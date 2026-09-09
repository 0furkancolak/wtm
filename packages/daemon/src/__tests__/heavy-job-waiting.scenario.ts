import assert from 'node:assert/strict';
import { SQLiteStateStore } from '@wtm/core';
import { protocolVersion } from '@wtm/protocol';
import { HeavyJobQueue } from '../heavy-job-queue';

const store = new SQLiteStateStore(':memory:');
const scope = 'waiting-host:user';
const now = new Date('2026-09-09T00:00:00.000Z');
const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
const trees = store.reconcileWorktrees(repository.id, ['/jobs', '/jobs-two'].map((path) => ({
  path, head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null,
}))).discovered;
const queue = new HeavyJobQueue({
  store: store.jobs, scope, maxConcurrent: 2, now: () => now,
  supervisor: { async start() { throw new Error('diagnostics must not spawn'); }, async stopRecord(record) { return record; }, list: () => [] },
  inspectGroup: async () => ({ status: 'absent' }),
  resolveTask: async (cwd) => {
    const tree = trees.find((entry) => entry.path === cwd)!;
    return { workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id, worktreePath: tree.path,
      taskName: 'check', timeoutMs: 1000, argv: ['node', 'check.js'], cwd: tree.path, shell: false, env: {} };
  },
  snapshot: async () => ({ fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
});

interface JobView { jobId: string; state: string; waitingReason: string | null }
async function request(command: string, arguments_: unknown) {
  return queue.handle({ protocol: protocolVersion, id: command, command, arguments: arguments_ });
}
async function view(command: string, jobId: string) {
  const response = await request(command, { jobId });
  return (response.data as { job: JobView }).job;
}
try {
  // Deliberately leave scheduling stopped: diagnostics must describe, not dispatch, these jobs.
  const first = await queue.enqueue('/jobs', 'check', 'first');
  const second = await queue.enqueue('/jobs', 'check', 'second');
  const third = await queue.enqueue('/jobs-two', 'check', 'third');
  assert.equal((await view('jobs.status', first.jobId)).waitingReason, 'dispatch_pending');
  assert.equal((await view('jobs.result', second.jobId)).waitingReason, 'fifo');
  assert.equal(store.jobs.claim(scope, 2, now.toISOString())?.jobId, first.jobId);
  assert.equal((await view('jobs.status', first.jobId)).waitingReason, null);
  assert.equal((await view('jobs.status', second.jobId)).waitingReason, 'worktree_busy');
  assert.equal((await view('jobs.status', third.jobId)).waitingReason, 'fifo');
  const listing = await request('jobs.list', {});
  assert.equal(listing.ok, true);
  const listed = (listing.data as { jobs: JobView[] }).jobs;
  assert.deepEqual(listed.map(({ jobId, waitingReason }) => [jobId, waitingReason]), [
    [third.jobId, 'fifo'], [second.jobId, 'worktree_busy'], [first.jobId, null],
  ]);
  assert.equal((await view('jobs.cancel', second.jobId)).waitingReason, null);
  assert.equal((await view('jobs.status', third.jobId)).waitingReason, 'dispatch_pending');
  assert.equal(store.jobs.claim(scope, 2, now.toISOString())?.jobId, third.jobId);
  const fourth = await queue.enqueue('/jobs-two', 'check', 'fourth');
  assert.equal((await view('jobs.status', fourth.jobId)).waitingReason, 'concurrency');
  assert.equal((await view('jobs.result', fourth.jobId)).waitingReason, 'concurrency');
  store.jobs.finish(first.jobId, { state: 'SUCCEEDED', exitCode: 0, signal: null, error: null, sourceValidity: 'UNCHANGED', now: now.toISOString() });
  assert.equal((await view('jobs.result', first.jobId)).waitingReason, null);
  assert.equal((await view('jobs.status', fourth.jobId)).waitingReason, 'worktree_busy');
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
