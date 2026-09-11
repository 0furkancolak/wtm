import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessCompletion } from '../logs';

const cancelled = process.argv[2] === 'cancelled';
const store = new SQLiteStateStore(':memory:');
const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, mainRoot: '/jobs', commonGitDir: '/jobs/.git', remoteIdentity: null });
const tree = store.reconcileWorktrees(repository.id, [{ path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', detached: false, bare: false, lockedReason: null, prunableReason: null }]).discovered[0]!;
let now = Date.parse('2026-09-09T00:00:00.000Z');
let alive = true;
let starts = 0;
const processes: ManagedProcessRecord[] = [];
let completion: ManagedProcessCompletion | null = null;
const queue = new HeavyJobQueue({
  store: store.jobs, scope: 'host:user', now: () => new Date(now),
  snapshot: async () => ({ fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
  resolveTask: async () => ({ workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id, worktreePath: tree.path, taskName: 'check', timeoutMs: 1000, argv: ['task'], cwd: tree.path, shell: false, env: {} }),
  inspectGroup: async () => alive ? { status: 'present', pids: [41] } : { status: 'absent' },
  supervisor: {
    async start(input) {
      starts++;
      const record: ManagedProcessRecord = { id: 'process', worktreeId: tree.id, taskName: input.taskName, pid: 41, pgid: 41, processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING', startedAt: new Date(now).toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false };
      processes.push(record);
      input.onRecorded?.(record);
      if (!cancelled) throw Object.assign(new Error('Anchor exit arrived before stderr refusal'), {
        code: 'RUNTIME_START_FAILED', context: { reason: 'ANCHOR_EXITED_BEFORE_LAUNCH', spawnOutcome: 'cleaned' },
      });
      return { record, existing: false };
    },
    async stopRecord(record) { return record; },
    list: () => processes,
  },
  logs: { read: async () => '', readCompletion: async () => completion, removeJob: async () => {} },
});

try {
  await queue.start();
  const accepted = await queue.enqueue('/jobs', 'check', 'timeout-evidence');
  await queue.flush();
  if (cancelled) await queue.cancel(accepted.jobId);
  assert.equal(queue.get(accepted.jobId).stopReason, cancelled ? 'CANCELLED' : 'INTERRUPTED');
  assert.equal(queue.get(accepted.jobId).slotHeld, true);
  // A reliable completion marker is consumed after the provisional control-channel result.
  now += 1001;
  completion = { pid: 41, exitCode: null, signal: null, completedAt: new Date(now).toISOString(), logFailed: false, timedOut: true };
  alive = false;
  await queue.flush();
  assert.equal(queue.get(accepted.jobId).state, cancelled ? 'CANCELLED' : 'TIMED_OUT');
  assert.equal(queue.get(accepted.jobId).stopReason, cancelled ? 'CANCELLED' : 'TIMED_OUT');
  assert.equal(queue.get(accepted.jobId).error, cancelled ? 'USER_CANCELLED' : 'TIMEOUT');
  assert.equal(queue.get(accepted.jobId).slotHeld, false);
  assert.equal(starts, 1, 'upgrading result evidence must never relaunch the task');
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
