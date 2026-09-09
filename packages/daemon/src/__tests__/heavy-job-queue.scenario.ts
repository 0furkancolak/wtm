import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { HeavyJobQueue } from '../heavy-job-queue';
import type { ManagedProcessStartInput } from '../process-supervisor';

const store = new SQLiteStateStore(':memory:');
let now = Date.parse('2026-09-09T00:00:00.000Z');
let source = 'a'.repeat(64);
let failBeforeRecord = false;
let snapshotDelay = 0;
let refuseDeadlineAtHandshake = false;
const groups = new Map<number, boolean>();
const starts: ManagedProcessStartInput[] = [];
const records = new Map<string, ManagedProcessRecord>();
const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
const repo = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/jobs/.git', mainRoot: '/jobs', remoteIdentity: null });
const trees = store.reconcileWorktrees(repo.id, ['/jobs', '/jobs-other'].map((path) => ({ path, head: 'a'.repeat(40), branch: 'refs/heads/main', bare: false, detached: false, lockedReason: null, prunableReason: null }))).discovered;
const supervisor = {
  async start(input: ManagedProcessStartInput) {
    starts.push(input);
    const pid = starts.length + 100;
    input.onSpawned?.(pid);
    groups.set(pid, true);
    if (failBeforeRecord) throw new Error('HANDSHAKE_FAILED');
    const record: ManagedProcessRecord = { id: String(pid), worktreeId: input.worktreeId, taskName: input.taskName, pid, pgid: pid, processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING', startedAt: new Date(now).toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false };
    records.set(record.id, record); groups.set(pid, true);
    input.onRecorded?.(record);
    if (refuseDeadlineAtHandshake) {
      groups.set(pid, false);
      throw Object.assign(new Error('Deadline expired before launch'), {
        code: 'RUNTIME_START_FAILED', context: { reason: 'ANCHOR_DEADLINE_EXPIRED', spawnOutcome: 'cleaned' },
      });
    }
    return { record, existing: false };
  },
  async stopRecord(record: ManagedProcessRecord) { return { ...record, state: 'STOPPED' as const }; },
  list() { return [...records.values()]; },
};
const queue = new HeavyJobQueue({
  store: store.jobs, scope: 'host:user', supervisor, now: () => new Date(now), maxConcurrent: 1,
  inspectGroup: async (pgid) => groups.get(pgid) === true ? { status: 'present', pids: [pgid] } : { status: 'absent' },
  snapshot: async () => { now += snapshotDelay; return { fingerprint: source, files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }; },
  resolveTask: async (cwd, taskName) => {
    const tree = trees.find(({ path }) => path === cwd)!;
    return { workspaceId: workspace.id, repositoryId: repo.id, worktreeId: tree.id, worktreePath: cwd, taskName, timeoutMs: 1000, argv: ['node', '-e', ''], cwd, shell: false, env: {} };
  },
});
try {
  await queue.start();
  const first = await queue.enqueue('/jobs', 'check', 'first');
  const second = await queue.enqueue('/jobs-other', 'check', 'second');
  assert.equal(first.state, 'QUEUED');
  assert.equal(starts.length, 0, 'acceptance must not wait for or start task inline');
  await queue.flush();
  assert.equal(starts.length, 1);
  assert.equal(queue.get(first.jobId).slotHeld, true);
  await queue.cancel(first.jobId);
  assert.equal(queue.get(first.jobId).slotHeld, true, 'STOPPED alone does not prove descendants gone');
  assert.equal(starts.length, 1);
  groups.set(101, false);
  await queue.flush();
  assert.equal(queue.get(first.jobId).state, 'CANCELLED');
  assert.equal(starts.length, 2);
  now += 1001;
  await queue.flush();
  assert.equal(queue.get(second.jobId).slotHeld, true, 'timeout must hold slot until descendants gone');
  groups.set(102, false);
  await queue.flush();
  assert.equal(queue.get(second.jobId).state, 'TIMED_OUT');
  const changed = await queue.enqueue('/jobs', 'check', 'changed');
  source = 'b'.repeat(64);
  await queue.flush();
  assert.equal(queue.get(changed.jobId).state, 'INTERRUPTED');
  assert.equal(starts.length, 2, 'changed queued sources must not execute');
  failBeforeRecord = true;
  const uncertain = await queue.enqueue('/jobs', 'check', 'uncertain-anchor');
  await queue.flush();
  assert.equal(queue.get(uncertain.jobId).slotHeld, true, 'failed handshake cannot release unconfirmed spawned anchor');
  await queue.flush();
  assert.equal(queue.get(uncertain.jobId).slotHeld, true);
  groups.set(103, false);
  await queue.flush();
  assert.equal(queue.get(uncertain.jobId).state, 'INTERRUPTED');
  assert.equal(queue.get(uncertain.jobId).slotHeld, false);
  assert.equal(starts.length, 3, 'uncertain job must never be relaunched');
  const expiredBeforeStart = await queue.enqueue('/jobs', 'check', 'expired-before-start');
  snapshotDelay = 1001;
  await queue.flush();
  assert.equal(queue.get(expiredBeforeStart.jobId).state, 'TIMED_OUT');
  assert.equal(starts.length, 3, 'expired preflight must not launch a command');
  snapshotDelay = 0; failBeforeRecord = false; refuseDeadlineAtHandshake = true;
  const expiredAtHandshake = await queue.enqueue('/jobs', 'check', 'expired-at-handshake');
  await queue.flush();
  assert.equal(queue.get(expiredAtHandshake.jobId).stopReason, 'TIMED_OUT', 'launch refusal must preserve timeout instead of replacing it with interruption');
  await queue.flush();
  assert.equal(queue.get(expiredAtHandshake.jobId).state, 'TIMED_OUT');
  assert.equal(queue.get(expiredAtHandshake.jobId).slotHeld, false);
  assert.equal(starts.length, 4, 'a deadline refusal must never relaunch the job');
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
