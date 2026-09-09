import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { protocolVersion } from '@wtm/protocol';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessCompletion } from '../logs';

const mode = process.argv[2];
assert.ok(mode === 'both-throw' || mode === 'final-throw' || mode === 'recovered'
  || mode === 'missing-after-failure' || mode === 'missing-next-poll'
  || mode === 'no-observed-exit' || mode === 'cancel' || mode === 'timeout');
const store = new SQLiteStateStore(':memory:');
const scope = 'completion-host:user';
const now = new Date('2026-09-09T00:00:00.000Z');
const workspace = store.upsertWorkspace({ name: 'completion', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
const tree = store.reconcileWorktrees(repository.id, [{
  path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null,
}]).discovered[0]!;
const processes: ManagedProcessRecord[] = [];
const liveGroups = new Set<number>();
let armed = false;
let reads = 0;
let confirmations = 0;
const completion: ManagedProcessCompletion = {
  pid: 101, exitCode: 0, signal: null, completedAt: now.toISOString(), logFailed: false, timedOut: false,
};
const queue = new HeavyJobQueue({
  store: store.jobs, scope, now: () => now,
  snapshot: async () => ({ fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
  resolveTask: async () => ({ workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id,
    worktreePath: tree.path, taskName: 'check', timeoutMs: 1000,
    argv: ['node', 'check.js'], cwd: tree.path, shell: false, env: {} }),
  inspectGroup: async (pgid) => liveGroups.has(pgid) ? { status: 'present', pids: [pgid] } : { status: 'absent' },
  supervisor: {
    async start(input) {
      const pid = 101 + processes.length;
      const record: ManagedProcessRecord = {
        id: `process-${pid}`, worktreeId: tree.id, taskName: input.taskName, pid, pgid: pid,
        processStartTime: `identity-${pid}`, commandFingerprint: 'fingerprint', state: 'RUNNING',
        startedAt: now.toISOString(), stoppedAt: null, stdoutPath: `/stdout-${pid}`, stderrPath: `/stderr-${pid}`, cleanupRequired: false,
      };
      processes.push(record);
      liveGroups.add(pid);
      input.onRecorded?.(record);
      return { record, existing: false };
    },
    async stopRecord() { throw new Error('A confirmed absent process group must not be signalled'); },
    async confirmStopped(record) {
      assert.equal(liveGroups.has(record.pgid), false, 'stop confirmation requires actual group absence');
      confirmations += 1;
    },
    list: () => processes,
  },
  logs: {
    read: async () => '', removeJob: async () => {},
    async readCompletion(_path, pid) {
      if (!armed || pid !== 101) return null;
      reads += 1;
      if (mode === 'final-throw' && reads === 1) return completion;
      if (mode === 'recovered' && reads > 1) return completion;
      if ((mode === 'missing-after-failure' || mode === 'missing-next-poll') && reads > 1) return null;
      throw new Error('Completion evidence failed validation');
    },
  },
});

try {
  await queue.start();
  const first = await queue.enqueue('/jobs', 'check', 'first');
  await queue.flush();
  const second = await queue.enqueue('/jobs', 'check', 'second');
  const process = processes[0]!;
  armed = true;
  if (mode !== 'no-observed-exit') {
    queue.recordExit(process, { exitCode: 0, signal: null, groupAbsent: false, exitedAt: now.toISOString() });
  }
  await queue.flush();
  // An anchor's exit is insufficient to release a slot while its process tree is still live.
  assert.equal(queue.get(first.jobId).state, 'RUNNING');
  assert.equal(queue.get(first.jobId).slotHeld, true);
  assert.equal(queue.get(second.jobId).state, 'QUEUED');
  assert.equal(processes.length, 1);
  assert.equal(confirmations, 0);

  liveGroups.delete(process.pgid);
  // Most cases start a fresh initial/final sequence. The cross-poll case leaves the failed
  // first read behind and presents only a missing marker on the next reconciliation.
  if (mode !== 'missing-next-poll') reads = 0;
  if (mode === 'cancel' || mode === 'timeout') {
    store.jobs.requestCancellation(first.jobId, scope, mode === 'cancel' ? 'CANCELLED' : 'TIMED_OUT', now.toISOString());
  }
  await queue.flush();
  const job = queue.get(first.jobId);
  const successful = mode === 'recovered';
  const state = successful ? 'SUCCEEDED' : mode === 'cancel' ? 'CANCELLED' : mode === 'timeout' ? 'TIMED_OUT' : 'INTERRUPTED';
  const error = successful ? null : mode === 'cancel' ? 'USER_CANCELLED' : mode === 'timeout' ? 'TIMEOUT' : 'COMPLETION_UNREADABLE';
  assert.equal(job.state, state, 'unreadable completion cannot verify a successful task result');
  assert.equal(reads, mode === 'missing-next-poll' ? 3 : 2, 'reconciliation must re-read completion after confirmed group absence');
  assert.equal(job.error, error, 'terminal finalization must preserve completion failure evidence');
  assert.equal(job.stopReason, mode === 'cancel' ? 'CANCELLED' : mode === 'timeout' ? 'TIMED_OUT' : null);
  assert.equal(job.exitCode, mode === 'no-observed-exit' ? null : 0, 'known exit evidence is retained and unavailable outcomes stay unknown');
  assert.equal(job.signal, null);
  assert.equal(job.sourceValidity, 'UNCHANGED');
  assert.equal(job.slotHeld, false);
  assert.ok(job.finishedAt !== null);
  assert.equal(confirmations, 1);
  assert.equal(queue.get(second.jobId).state, 'RUNNING', 'absent failed work must not hold the next FIFO slot forever');
  assert.equal(queue.get(second.jobId).slotHeld, true);
  assert.equal(processes.length, 2);

  const result = await queue.handle({ protocol: protocolVersion, id: 'result', command: 'jobs.result', arguments: { jobId: first.jobId } });
  assert.equal(result.ok, successful);
  if (!successful) assert.equal(result.errors[0]?.code, 'WTM_JOB_UNSUCCESSFUL');
  const data = result.data as { terminal: boolean; successful: boolean };
  assert.equal(data.terminal, true);
  assert.equal(data.successful, successful);
  const repeated = await queue.enqueue('/jobs', 'check', 'first');
  assert.equal(repeated.jobId, first.jobId);
  assert.equal(repeated.reused, true);
  assert.deepEqual(queue.get(first.jobId), job, 'a retry must preserve the terminal evidence without replay');
  assert.equal(processes.filter((record) => record.taskName === `job-${first.jobId}`).length, 1);
  console.log(JSON.stringify({ mode, state, error, nextSlotStarted: true }));
} finally { await queue.close(); store.close(); }
