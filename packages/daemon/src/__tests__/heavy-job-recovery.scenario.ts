import assert from 'node:assert/strict';
import { SQLiteStateStore, type ManagedProcessRecord } from '@wtm/core';
import { jsonEnvelopeSchema, protocolVersion } from '@wtm/protocol';
import { HeavyJobQueue, type HeavyJobQueueOptions } from '../heavy-job-queue';
import type { ManagedProcessCompletion } from '../logs';

const store = new SQLiteStateStore(':memory:');
const workspace = store.upsertWorkspace({ name: 'jobs', root: '/jobs', scope: 'local', configPath: null });
const repository = store.upsertRepository({ workspaceId: workspace.id, mainRoot: '/jobs', commonGitDir: '/jobs/.git', remoteIdentity: null });
const tree = store.reconcileWorktrees(repository.id, [{ path: '/jobs', head: 'a'.repeat(40), branch: 'refs/heads/main', detached: false, bare: false, lockedReason: null, prunableReason: null }]).discovered[0]!;
let now = Date.parse('2026-09-09T00:00:00.000Z');
let source = 'a'.repeat(64);
let starts = 0;
let stops = 0;
const processes: ManagedProcessRecord[] = [];
const alive = new Set<number>();
const completions = new Map<number, ManagedProcessCompletion>();
const options: HeavyJobQueueOptions = {
  store: store.jobs, scope: 'host:user', now: () => new Date(now),
  snapshot: async () => ({ fingerprint: source, files: 1, bytes: 1, scope: 'git-tracked-and-untracked' }),
  resolveTask: async () => ({ workspaceId: workspace.id, repositoryId: repository.id, worktreeId: tree.id, worktreePath: tree.path, taskName: 'check', timeoutMs: 1000, argv: ['secret-command'], cwd: tree.path, shell: false, env: { TOKEN: 'secret-value' } }),
  inspectGroup: async (pgid) => alive.has(pgid) ? { status: 'present', pids: [pgid] } : { status: 'absent' },
  supervisor: {
    async start(input) {
      const pid = ++starts + 100;
      const process: ManagedProcessRecord = { id: String(pid), worktreeId: tree.id, taskName: input.taskName, pid, pgid: pid, processStartTime: 'identity', commandFingerprint: 'fingerprint', state: 'RUNNING', startedAt: new Date(now).toISOString(), stoppedAt: null, stdoutPath: '/stdout', stderrPath: '/stderr', cleanupRequired: false };
      processes.push(process); alive.add(pid); input.onRecorded?.(process);
      return { record: process, existing: false };
    },
    async stopRecord(process) { stops++; alive.delete(process.pgid); process.state = 'STOPPED'; return process; },
    list: () => processes,
  },
  logs: {
    read: async () => 'bounded task output\n',
    readCompletion: async (_path, pid) => completions.get(pid) ?? null,
    removeJob: async () => {},
  },
};
let queue = new HeavyJobQueue(options);
async function request(command: string, arguments_: unknown) {
  const envelope = await queue.handle({ protocol: protocolVersion, id: command, command, arguments: arguments_ });
  assert.equal(jsonEnvelopeSchema.safeParse(envelope).success, true, `Invalid envelope from ${command}`);
  assert.equal(JSON.stringify(envelope).includes('secret-value'), false);
  assert.equal(JSON.stringify(envelope).includes('secret-command'), false);
  return envelope;
}
try {
  await queue.start();
  const admission = await request('jobs.enqueue', { cwd: '/jobs', taskName: 'check', idempotencyKey: 'failed' });
  const failedId = (admission.data as { jobId: string }).jobId;
  await request('jobs.list', {});
  await request('jobs.status', { jobId: failedId });
  assert.equal((await request('jobs.result', { jobId: failedId })).errors[0]?.code, 'WTM_JOB_NOT_COMPLETE');
  assert.equal((await request('jobs.logs', { jobId: failedId, tail: 0 })).errors[0]?.code, 'WTM_DAEMON_INVALID_REQUEST');
  await queue.flush();
  await request('jobs.logs', { jobId: failedId, tail: 1 });
  completions.set(101, { pid: 101, exitCode: 7, signal: null, completedAt: new Date(now + 100).toISOString(), logFailed: false });
  alive.delete(101); now += 2000;
  await queue.flush();
  assert.equal(queue.get(failedId).state, 'FAILED', 'consuming a finished job after deadline must preserve its actual completion');
  assert.equal(queue.get(failedId).exitCode, 7);
  assert.equal((await request('jobs.result', { jobId: failedId })).errors[0]?.code, 'WTM_JOB_UNSUCCESSFUL');
  const succeeded = await queue.enqueue('/jobs', 'check', 'durable-success');
  await queue.flush(); await queue.close();
  completions.set(102, { pid: 102, exitCode: 0, signal: null, completedAt: new Date(now + 100).toISOString(), logFailed: false });
  alive.delete(102); now += 2000;
  queue = new HeavyJobQueue(options); await queue.start(); await queue.flush();
  assert.equal(queue.get(succeeded.jobId).state, 'SUCCEEDED');
  assert.equal(starts, 2, 'completed job is never launched again after restart');
  assert.equal((await request('jobs.result', { jobId: succeeded.jobId })).ok, true);
  const interrupted = await queue.enqueue('/jobs', 'check', 'interrupted');
  await queue.flush(); await queue.close();
  queue = new HeavyJobQueue(options); await queue.start(); await queue.flush();
  assert.equal(queue.get(interrupted.jobId).state, 'INTERRUPTED');
  assert.equal(stops, 1); assert.equal(starts, 3);
  const cancelled = await queue.enqueue('/jobs', 'check', 'queued-cancel');
  await request('jobs.cancel', { jobId: cancelled.jobId });
  assert.equal(queue.get(cancelled.jobId).state, 'CANCELLED');
  source = 'b'.repeat(64);
  assert.equal((await request('jobs.result', { jobId: succeeded.jobId })).errors[0]?.code, 'WTM_JOB_SOURCE_CHANGED');
  assert.equal((await request('jobs.status', { jobId: 'missing' })).errors[0]?.code, 'WTM_JOB_NOT_FOUND');
  const admissions = [queue.enqueue('/jobs', 'check', 'admission-one'), queue.enqueue('/jobs', 'check', 'admission-two')];
  await assert.rejects(queue.enqueue('/jobs', 'check', 'admission-three'), /Two job admission checks/);
  await Promise.all(admissions);
  console.log(JSON.stringify({ ok: true }));
} finally { await queue.close(); store.close(); }
