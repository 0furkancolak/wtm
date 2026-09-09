import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { protocolVersion } from '@wtm/protocol';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessStartInput } from '../process-supervisor';

const store = new SQLiteStateStore(':memory:');
const workspace = store.upsertWorkspace({ name: 'race', root: '/race', scope: 'local', configPath: null });
const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/race/.git', mainRoot: '/race', remoteIdentity: null });
const tree = store.reconcileWorktrees(repo.id, [{ path: '/race', head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }]).discovered[0];
assert.ok(tree);
const now = new Date('2026-09-09T00:00:00.000Z');
const records: ManagedProcessRecord[] = [];
let holdSnapshot = false;
const entered = Promise.withResolvers<void>();
const released = Promise.withResolvers<void>();
const queue = new HeavyJobQueue({
  store: store.jobs, scope: 'host:user', now: () => now,
  supervisor: {
    async start(input: ManagedProcessStartInput) {
      const record: ManagedProcessRecord = {
        id: 'process-1', worktreeId: tree.id, taskName: input.taskName, pid: 101, pgid: 101,
        processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING',
        startedAt: now.toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false,
      };
      records.push(record);
      input.onSpawned?.(record.pid);
      input.onRecorded?.(record);
      return { record, existing: false };
    },
    async stopRecord(record) { return record; },
    list() { return records; },
  },
  inspectGroup: async () => ({ status: 'absent' }),
  resolveTask: async () => ({
    workspaceId: workspace.id, repositoryId: repo.id, worktreeId: tree.id, worktreePath: '/race',
    taskName: 'check', timeoutMs: 1000, argv: ['node', '-e', ''], cwd: '/race', shell: false, env: {},
  }),
  snapshot: async () => {
    if (holdSnapshot) { entered.resolve(); await released.promise; }
    return { fingerprint: 'a'.repeat(64), files: 1, bytes: 1, scope: 'git-tracked-and-untracked' };
  },
});

try {
  await queue.start();
  const accepted = await queue.enqueue('/race', 'check', 'race');
  await queue.flush();
  const record = records[0];
  assert.ok(record);
  queue.recordExit(record, { exitCode: 0, signal: null, groupAbsent: true });
  holdSnapshot = true;
  const finalizing = queue.flush();
  await entered.promise;
  // Completion has selected success, but source verification has not finished. Cancellation
  // commits independently of the scheduler operation that is paused at this exact boundary.
  const cancelling = queue.cancel(accepted.jobId);
  assert.equal(queue.get(accepted.jobId).stopReason, 'CANCELLED');
  assert.equal(queue.get(accepted.jobId).slotHeld, true);
  released.resolve();
  await Promise.all([finalizing, cancelling]);
  holdSnapshot = false;

  const final = queue.get(accepted.jobId);
  assert.equal(final.state, 'CANCELLED', 'final source verification must not erase accepted cancellation');
  assert.equal(final.stopReason, 'CANCELLED');
  assert.equal(final.error, 'USER_CANCELLED');
  assert.equal(final.exitCode, 0);
  assert.equal(final.signal, null);
  assert.equal(final.slotHeld, false);
  const result = await queue.handle({ protocol: protocolVersion, id: 'result', command: 'jobs.result', arguments: { jobId: accepted.jobId } });
  assert.equal(result.ok, false, 'an agent must not accept a cancelled job as successful validation');
  assert.equal(result.errors[0]?.code, 'WTM_JOB_UNSUCCESSFUL');
  const data = result.data as { terminal: boolean; successful: boolean };
  assert.equal(data.terminal, true);
  assert.equal(data.successful, false);
  console.log(JSON.stringify({ ok: true }));
} finally {
  released.resolve();
  await queue.close();
  store.close();
}
