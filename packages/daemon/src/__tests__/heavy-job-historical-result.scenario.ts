import assert from 'node:assert/strict';
import { SQLiteStateStore } from '@wtm/core';
import { protocolVersion } from '@wtm/protocol';
import { nodeSqliteDatabaseFactory } from '../../../core/src/state/node-sqlite-driver';
import { HeavyJobQueue } from '../heavy-job-queue';

const database = nodeSqliteDatabaseFactory(':memory:', { readonly: false });
const store = new SQLiteStateStore(':memory:', { databaseFactory: () => database });
const scope = 'historical-host:user';
const now = new Date('2026-09-09T00:00:00.000Z');
const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
const tree = store.reconcileWorktrees(repository.id, [{
  path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null,
}]).discovered[0]!;
const queue = new HeavyJobQueue({
  store: store.jobs, scope, now: () => now,
  supervisor: { async start() { throw new Error('historical results must not relaunch'); }, async stopRecord(record) { return record; }, list: () => [] },
  inspectGroup: async () => ({ status: 'absent' }),
  resolveTask: async () => ({ workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id, worktreePath: tree.path,
    taskName: 'check', timeoutMs: 1000, argv: ['node', 'check.js'], cwd: tree.path, shell: false, env: {} }),
  snapshot: async () => ({ fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
});

try {
  for (const stopReason of [null, 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED'] as const) {
    const accepted = await queue.enqueue('/jobs', 'check', stopReason ?? 'success-control');
    assert.equal(store.jobs.claim(scope, 1, now.toISOString())?.jobId, accepted.jobId);
    if (stopReason !== null) store.jobs.requestCancellation(accepted.jobId, scope, stopReason, now.toISOString());
    // Reproduce the exact persisted inconsistency written by finish before stop arbitration
    // was fixed. The existing database factory seam grants test access without a product API.
    database.prepare(`UPDATE heavy_jobs SET state = 'SUCCEEDED', slot_held = 0, finished_at = ?,
      exit_code = 0, signal = NULL, error = NULL, source_validity = 'UNCHANGED' WHERE job_id = ?`)
      .run(now.toISOString(), accepted.jobId);
    const persisted = queue.get(accepted.jobId);
    assert.equal(persisted.state, 'SUCCEEDED');
    assert.equal(persisted.exitCode, 0);
    assert.equal(persisted.stopReason, stopReason);
    const result = await queue.handle({
      protocol: protocolVersion, id: 'historical-result', command: 'jobs.result', arguments: { jobId: accepted.jobId },
    });
    const data = result.data as { terminal: boolean; successful: boolean; job: { state: string; exitCode: number; stopReason: string | null; waitingReason: string | null } };
    assert.equal(result.ok, stopReason === null, `historical ${String(stopReason)} must never verify as a successful job`);
    assert.equal(data.terminal, true);
    assert.equal(data.successful, stopReason === null);
    if (stopReason !== null) assert.equal(result.errors[0]?.code, 'WTM_JOB_UNSUCCESSFUL');
    assert.equal(data.job.state, 'SUCCEEDED', 'result lookup preserves historical state for diagnosis');
    assert.equal(data.job.exitCode, 0);
    assert.equal(data.job.stopReason, stopReason);
    assert.equal(data.job.waitingReason, null);
    assert.deepEqual(queue.get(accepted.jobId), persisted, 'result lookup must not rewrite terminal history');
  }
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
