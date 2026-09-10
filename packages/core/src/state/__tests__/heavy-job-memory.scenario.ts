import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteStateStore } from '../sqlite-store';
import type { HeavyJobEnqueueInput } from '../jobs';
import { betterSqliteDatabaseFactory } from '../better-sqlite-driver';

const now = '2026-09-10T00:00:00.000Z';
const memory = { budgetBytes: 800, reserveBytes: 200, availableBytes: 2000, totalBytes: 4000 };
const scope = 'host:user';
if (process.argv[2] === 'claim') {
  const store = new SQLiteStateStore(process.argv[3]!);
  try { console.log(JSON.stringify(store.jobs.claim(scope, 4, now, memory)?.jobId ?? null)); }
  finally { store.close(); }
} else {
  const root = await mkdtemp(join(tmpdir(), 'wtm-memory-admission-'));
  const databasePath = join(root, 'state.db');
  let store = new SQLiteStateStore(databasePath);
  try {
    const workspace = store.upsertWorkspace({ name: 'memory', root: '/memory', scope: 'local', configPath: null });
    const registration = (index: number): HeavyJobEnqueueInput => {
      const path = `/memory-${String(index)}`;
      const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: `${path}/.git`, mainRoot: path, remoteIdentity: null });
      const tree = store.reconcileWorktrees(repo.id, [{ path, head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }]).discovered[0]!;
      return { scope, workspaceId: workspace.id, repositoryId: repo.id, worktreeId: tree.id, worktreePath: path, taskName: 'build', commandFingerprint: 'b'.repeat(64), sourceFingerprint: 'c'.repeat(64), timeoutMs: 1000, now, idempotencyKey: String(index), memoryEstimateBytes: 600 };
    };
    const firstInput = registration(1);
    const first = store.jobs.enqueue(firstInput).job;
    const second = store.jobs.enqueue(registration(2)).job;
    const small = store.jobs.enqueue({ ...registration(3), memoryEstimateBytes: 100 }).job;
    assert.equal(first.memoryEstimateBytes, 600, 'accepted estimates must be durable');
    assert.equal(store.jobs.enqueue(firstInput).reused, true);
    assert.throws(() => store.jobs.enqueue({ ...firstInput, memoryEstimateBytes: 601 }), /different request/);
    const claim = async () => await new Promise<string | null>((resolve, reject) => {
      const child = spawn('node', ['--import', 'tsx', fileURLToPath(import.meta.url), 'claim', databasePath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout) as string | null) : reject(new Error(stderr)));
    });
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.filter(Boolean), [first.jobId], 'two SQLite claimants cannot oversubscribe estimates');
    assert.equal(store.jobs.waitingReasons(scope, 4, memory).get(second.jobId), 'memory_budget');
    assert.equal(store.jobs.waitingReasons(scope, 4, memory).get(small.jobId), 'fifo');
    store.jobs.requestCancellation(first.jobId, scope, 'CANCELLED', now);
    assert.equal(store.jobs.claim(scope, 4, now, memory), null, 'cancellation cannot prematurely free the reservation');
    store.close(); store = new SQLiteStateStore(databasePath);
    assert.equal(store.jobs.get(first.jobId, scope)?.memoryEstimateBytes, 600);
    assert.equal(store.jobs.claim(scope, 4, now, memory), null, 'restart cannot erase memory ownership');
    store.jobs.finish(first.jobId, { state: 'CANCELLED', exitCode: null, signal: null, error: null, sourceValidity: 'UNCHANGED', now });
    // A smaller configured budget after restart terminalizes an impossible head, without
    // executing it or starving the valid next job. A transient available-memory shortage does not.
    assert.equal(store.jobs.claim(scope, 4, now, { ...memory, budgetBytes: 500 })?.jobId, small.jobId);
    assert.equal(store.jobs.get(second.jobId, scope)?.state, 'FAILED');
    assert.equal(store.jobs.get(second.jobId, scope)?.error, 'WTM_JOB_MEMORY_BUDGET_EXCEEDED');
    assert.equal(store.jobs.get(second.jobId, scope)?.exitCode, null);
    assert.equal(store.jobs.get(second.jobId, scope)?.startedAt, null);
    const legacy = store.jobs.enqueue({ ...registration(4), memoryEstimateBytes: null }).job;
    assert.equal(store.jobs.claim(scope, 4, now, memory), null);
    assert.equal(store.jobs.get(legacy.jobId, scope)?.error, 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED');
    // Even inconsistent legacy state must not hide explicit slot ownership during policy
    // filtering. This is a store fixture, not evidence of an actually stopped process.
    const raw = betterSqliteDatabaseFactory(databasePath, { readonly: false });
    try { raw.prepare("UPDATE heavy_jobs SET state = 'QUEUED', slot_held = 1 WHERE job_id = ?").run(legacy.jobId); }
    finally { raw.close(); }
    store.jobs.enqueue({ ...registration(5), memoryEstimateBytes: 100 });
    assert.equal(store.jobs.claim(scope, 4, now, memory), null, 'policy filtering must not discard an unknown held reservation');
    assert.equal(store.jobs.get(legacy.jobId, scope)?.slotHeld, true);
    assert.throws(() => store.acquireRepositoryOperationLease({ repositoryId: small.repositoryId, operation: 'remove', token: 'remove', pid: 1, processStartTime: 'identity', hostId: 'host', ttlMs: 1000 }, now), /pending or running/);
    console.log(JSON.stringify({ ok: true }));
  } finally { store.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
