import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessCompletion } from '../logs';

const mode = process.argv[2];
assert.ok(mode === 'task-signal' || mode === 'anchor-signal' || mode === 'deadline-refusal'
  || mode === 'cancel-stop' || mode === 'timeout-stop' || mode === 'confirm-stop');
const stopping = mode === 'cancel-stop' || mode === 'timeout-stop' || mode === 'confirm-stop';
const store = new SQLiteStateStore(':memory:');
const now = new Date('2026-09-09T00:00:00.000Z');
const workspace = store.upsertWorkspace({ name: 'exit', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
const tree = store.reconcileWorktrees(repository.id, [{ path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }]).discovered[0]!;
const processes: ManagedProcessRecord[] = [];
let completion: ManagedProcessCompletion | null = null;
let alive = true;
const queue = new HeavyJobQueue({
  store: store.jobs, scope: 'host:user', now: () => now,
  snapshot: async () => ({ fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
  resolveTask: async () => ({ workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id, worktreePath: tree.path, taskName: 'check', timeoutMs: 1000, argv: ['node', 'check.js'], cwd: tree.path, shell: false, env: {} }),
  inspectGroup: async () => alive ? { status: 'present', pids: [101] } : { status: 'absent' },
  supervisor: {
    async start(input) {
      const record: ManagedProcessRecord = {
        id: 'process-1', worktreeId: tree.id, taskName: input.taskName, pid: 101, pgid: 101,
        processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING',
        startedAt: now.toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false,
      };
      processes.push(record); input.onRecorded?.(record);
      return { record, existing: false };
    },
    async stopRecord(record) {
      assert.ok(stopping, 'completed process tree must not be signalled');
      // The anchor publishes final task evidence while stopRecord is awaited. In the timeout
      // case this replaces the provisional null/null deadline marker read before signalling.
      completion = mode === 'confirm-stop' ? null : { pid: 101, exitCode: null, signal: 'SIGTERM',
        completedAt: new Date(now.getTime() + 200).toISOString(), logFailed: false,
        timedOut: mode === 'timeout-stop' };
      alive = false;
      return { ...record, state: 'STOPPED' };
    },
    async confirmStopped(record) {
      // Production exit callbacks share the supervisor lifecycle lock. A queued callback
      // can publish its fallback evidence while final stop confirmation waits for that lock.
      if (mode === 'confirm-stop') queue.recordExit(record, {
        exitCode: null, signal: 'SIGKILL', groupAbsent: true, exitedAt: now.toISOString(),
      });
    },
    list: () => processes,
  },
  logs: { read: async () => '', readCompletion: async () => completion, removeJob: async () => {} },
});
try {
  await queue.start();
  const accepted = await queue.enqueue('/jobs', 'check', mode);
  await queue.flush();
  assert.equal(queue.get(accepted.jobId).slotHeld, true);
  if (stopping) {
    if (mode === 'timeout-stop') completion = { pid: 101, exitCode: null, signal: null,
      completedAt: now.toISOString(), logFailed: false, timedOut: true };
    else store.jobs.requestCancellation(accepted.jobId, 'host:user', 'CANCELLED', now.toISOString());
    await queue.flush();
    const stopped = queue.get(accepted.jobId);
    assert.equal(stopped.state, mode === 'timeout-stop' ? 'TIMED_OUT' : 'CANCELLED');
    assert.equal(stopped.exitCode, null);
    assert.equal(stopped.signal, mode === 'confirm-stop' ? 'SIGKILL' : 'SIGTERM', 'evidence published during stop must not be lost');
    assert.equal(stopped.slotHeld, false);
  } else {
    completion = {
      pid: 101, exitCode: mode === 'anchor-signal' ? 0 : null,
      signal: mode === 'task-signal' ? 'SIGTERM' : null,
      completedAt: new Date(now.getTime() + 100).toISOString(), logFailed: false, timedOut: mode === 'deadline-refusal',
    };
    // The anchor is a separate process. Its numeric signal mapping or later signal must not
    // replace either null in the task's authenticated, durable completion tuple.
    alive = false;
    queue.recordExit(processes[0]!, {
      exitCode: mode === 'task-signal' ? 143 : mode === 'deadline-refusal' ? 124 : null,
      signal: mode === 'anchor-signal' ? 'SIGKILL' : null, groupAbsent: true,
      exitedAt: new Date(now.getTime() + 200).toISOString(),
    });
    await queue.flush();
    const result = queue.get(accepted.jobId);
    assert.equal(result.exitCode, completion.exitCode);
    assert.equal(result.signal, completion.signal);
    assert.equal(result.state, mode === 'task-signal' ? 'FAILED' : mode === 'deadline-refusal' ? 'TIMED_OUT' : 'SUCCEEDED');
    assert.equal(result.stopReason, mode === 'deadline-refusal' ? 'TIMED_OUT' : null);
    assert.equal(result.slotHeld, false);
  }
} finally { await queue.close(); store.close(); }
