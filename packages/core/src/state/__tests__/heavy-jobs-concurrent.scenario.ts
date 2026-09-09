import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteStateStore } from '../sqlite-store';
import type { HeavyJobEnqueueInput } from '../jobs';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'worker') {
  const databasePath = process.argv[3]!;
  const input = JSON.parse(process.argv[4]!) as HeavyJobEnqueueInput;
  const store = new SQLiteStateStore(databasePath);
  try {
    if (process.argv[5] === 'remove') {
      try {
        store.acquireRepositoryOperationLease({ repositoryId: input.repositoryId, operation: 'remove', token: 'remove', pid: process.pid, processStartTime: 'test-identity', hostId: 'host', ttlMs: 60_000 }, input.now);
        console.log(JSON.stringify({ removed: true }));
      } catch { console.log(JSON.stringify({ removed: false })); }
    } else {
      try {
        const accepted = store.jobs.enqueue(input);
        const claimed = store.jobs.claim(input.scope, 1, input.now);
        console.log(JSON.stringify({ jobId: accepted.job.jobId, claimed: claimed?.jobId ?? null }));
      } catch { console.log(JSON.stringify({ refused: true })); }
    }
  } finally { store.close(); }
} else {
  const root = await mkdtemp(join(tmpdir(), 'wtm-job-race-'));
  try {
    const databasePath = join(root, 'state.db');
    const store = new SQLiteStateStore(databasePath);
    store.jobs.assertScope('scope-owner');
    const otherConnection = new SQLiteStateStore(databasePath);
    otherConnection.jobs.assertScope('scope-owner');
    assert.throws(() => otherConnection.jobs.assertScope('foreign-host-owner'), /another host/);
    otherConnection.close();
    const workspace = store.upsertWorkspace({ name: 'race', root: '/race', scope: 'local', configPath: null });
    function registration(path: string) {
      const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: `${path}/.git`, mainRoot: path, remoteIdentity: null });
      const tree = store.reconcileWorktrees(repo.id, [{ path, head: 'a'.repeat(40), branch: 'refs/heads/main', detached: false, bare: false, lockedReason: null, prunableReason: null }]).discovered[0]!;
      return { repositoryId: repo.id, worktreeId: tree.id, worktreePath: path };
    }
    const input: HeavyJobEnqueueInput = { ...registration('/race-one'), workspaceId: workspace.id, scope: 'host:user', taskName: 'check', commandFingerprint: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), timeoutMs: 1000, now: '2026-09-09T00:00:00.000Z', idempotencyKey: 'same-key' };
    const other = { ...input, ...registration('/race-two'), idempotencyKey: 'other-key' };
    const removal = { ...input, ...registration('/race-removal'), scope: 'removal-scope', idempotencyKey: 'remove-race' };
    async function worker(value: HeavyJobEnqueueInput, mode = 'enqueue'): Promise<Record<string, unknown>> {
      return await new Promise((resolve, reject) => {
        const child = spawn('node', ['--import', 'tsx', self, 'worker', databasePath, JSON.stringify(value), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.once('error', reject);
        child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout) as Record<string, unknown>); });
      });
    }
    const accepted = await Promise.all([worker(input), worker(input), worker(other), worker(other)]);
    assert.equal(new Set(accepted.map(({ jobId }) => jobId)).size, 2, 'same-key retries across SQLite connections must identify one row');
    assert.equal(accepted.filter(({ claimed }) => claimed !== null).length, 1, 'only one concurrent claimant reserves global slot');
    const active = store.jobs.active(input.scope);
    assert.equal(active.length, 2);
    assert.equal(active.filter(({ slotHeld }) => slotHeld).length, 1);
    assert.equal(active.find(({ slotHeld }) => slotHeld)?.sequence, Math.min(...active.map(({ sequence }) => sequence)));
    const [admission, deletion] = await Promise.all([worker(removal), worker(removal, 'remove')]);
    assert.notEqual(admission.refused === true, deletion.removed === false, 'exactly one of racing removal or admission must win');
    store.close();
    console.log(JSON.stringify({ ok: true }));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
