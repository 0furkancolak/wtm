import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessStartInput } from '../process-supervisor';

const store = new SQLiteStateStore(':memory:');
const workspace = store.upsertWorkspace({ name: 'memory', root: '/memory', scope: 'local', configPath: null });
const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/memory/.git', mainRoot: '/memory', remoteIdentity: null });
const trees = store.reconcileWorktrees(repo.id, ['/one', '/two', '/three'].map((path) => ({ path, head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }))).discovered;
const records: ManagedProcessRecord[] = [];
const alive = new Set<number>();
let availableBytes = 500;
let reads = 0;
let failRead = false;
let estimate: number | null = 600;
let env = { WORKERS: '2' };
const starts: ManagedProcessStartInput[] = [];
const queue = new HeavyJobQueue({
  store: store.jobs, scope: 'host:user', maxConcurrent: 4,
  memory: { budgetBytes: 800, reserveBytes: 200 },
  readMemory: () => { reads += 1; if (failRead) throw new Error('secret'); return { availableBytes, totalBytes: 2000 }; },
  resolveTask: async (cwd, taskName) => ({ workspaceId: workspace.id, repositoryId: repo.id, worktreeId: trees.find((tree) => tree.path === cwd)!.id, worktreePath: cwd, taskName, timeoutMs: 60000, memoryEstimateBytes: estimate, argv: ['node', '-e', ''], cwd, shell: false, env }),
  snapshot: async () => ({ fingerprint: 'b'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
  inspectGroup: async (pgid) => alive.has(pgid) ? { status: 'present', pids: [pgid] } : { status: 'absent' },
  supervisor: {
    async start(input) {
      starts.push(input);
      const pid = 100 + starts.length;
      const record: ManagedProcessRecord = { id: String(pid), worktreeId: input.worktreeId, taskName: input.taskName, pid, pgid: pid, processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING', startedAt: new Date().toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false };
      records.push(record); alive.add(pid); input.onSpawned?.(pid); input.onRecorded?.(record);
      return { record, existing: false };
    },
    async stopRecord(record) { return { ...record, state: 'STOPPED' }; },
    list() { return records; },
  },
});
const status = (jobId: string) => queue.handle({ protocol: { major: 1, minor: 0 }, id: 'status', command: 'jobs.status', arguments: { jobId } });
try {
  await queue.start();
  const first = await queue.enqueue('/one', 'build', 'one');
  const second = await queue.enqueue('/two', 'build', 'two');
  assert.equal(starts.length, 0);
  assert.equal(first.accepted, true);
  await queue.flush();
  assert.equal(starts.length, 0, 'temporary shortage must defer rather than run or reject');
  const waiting = await status(first.jobId);
  assert.equal((waiting.data as any).job.waitingReason, 'memory_budget');
  assert.equal((waiting.data as any).job.memoryEstimateBytes, 600);
  assert.equal((waiting.data as any).memory.availableBytes, 500);
  assert.equal((waiting.data as any).memory.reserveBytes, 200);
  availableBytes = 2000;
  await queue.flush();
  assert.equal(starts.length, 1);
  assert.equal(((await status(second.jobId)).data as any).job.waitingReason, 'memory_budget');
  await queue.cancel(first.jobId);
  assert.equal(queue.get(first.jobId).slotHeld, true);
  assert.equal(starts.length, 1, 'uncertain descendants still reserve memory');
  alive.clear(); failRead = true;
  await queue.flush();
  assert.equal(queue.get(first.jobId).state, 'CANCELLED');
  assert.equal(starts.length, 1, 'sampling failure must not permit a launch');
  assert.equal((await status(second.jobId)).errors.length, 0, 'status is still readable with unknown memory');
  failRead = false;
  await queue.flush();
  assert.equal(starts.length, 2);
  assert.ok(reads < 30, 'memory reading is bounded by admissions/dispatch/explicit queries');
  estimate = 801;
  await assert.rejects(queue.enqueue('/three', 'build', 'too-large'), { code: 'WTM_JOB_MEMORY_BUDGET_EXCEEDED' });
  estimate = null;
  await assert.rejects(queue.enqueue('/three', 'build', 'missing'), { code: 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED' });
  estimate = 100;
  const changed = await queue.enqueue('/three', 'build', 'changed-workers');
  env = { WORKERS: '4' };
  await queue.flush();
  assert.equal(queue.get(changed.jobId).state, 'INTERRUPTED', 'changed worker configuration invalidates accepted command');
  assert.equal(starts.length, 2);
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
