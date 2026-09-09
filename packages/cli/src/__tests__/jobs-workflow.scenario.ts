import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { enqueueAcceptanceSchema, type JobState, type JobWaitingReason, type JsonEnvelope, type SourceValidity } from '@wtm/protocol';
import { stringify } from 'smol-toml';
import { createProductionDaemon } from '../../../daemon/src/runtime-factory';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { DaemonClient } from '../client';
import { runCli } from '../main';
import { createQueueTaskFixture } from './jobs-task-fixture';

const fixture = await createWorkspaceFixture();
const socketRoot = await mkdtemp(join(shortTmpRoot(), 'wtm-jobs-'));
const releasePath = join(socketRoot, 'release');
const runtime = await createProductionDaemon({
  dataRoot: join(fixture.userDataDir, 'queue'), socketPath: join(socketRoot, 'wtmd.sock'),
  logRoot: join(fixture.userDataDir, 'logs'), globalConfigPath: join(socketRoot, 'global.toml'),
  runtimeInvocation: developmentRuntimeInvocation(), gracePeriodMs: 100, pollIntervalMs: 10,
});
const client = new DaemonClient({ socketPath: runtime.paths.socketPath });
let connected = false;
try {
  // The external barrier is only test coordination. The task never writes its source worktree.
  const taskFixture = createQueueTaskFixture(releasePath);
  await writeFile(join(fixture.root, 'wtm.toml'), stringify(taskFixture.config));
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'jobs-fixture', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  for (const repoPath of [fixture.firstRepoPath, fixture.secondRepoPath]) {
    for (const [path, contents] of Object.entries(taskFixture.files)) {
      await writeFile(join(repoPath, path), contents);
    }
    const identity = await readGitRepositoryIdentity(repoPath);
    const repository = runtime.stateStore.upsertRepository({
      workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: repoPath, remoteIdentity: null,
    });
    runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(repoPath));
  }
  await runtime.start();
  await client.start();
  connected = true;
  // Settle both submissions before cleanup can inspect the queue or remove their sources.
  const submissions = await Promise.allSettled([
    submit(fixture.firstRepoPath, 'native-first'), submit(fixture.secondRepoPath, 'native-second'),
  ]);
  const accepted = submissions.map((submission) => {
    if (submission.status === 'rejected') throw submission.reason;
    return submission.value;
  });
  const ids = accepted.map((entry) => entry.jobId);
  assert.notEqual(ids[0], ids[1]);
  // Both actual CLI children have exited while neither task can have completed.
  await until('shared slot before release', ids, (states) => {
    return states.filter((job) => job.state === 'RUNNING').length === 1
      && states.filter((job) => job.state === 'QUEUED').length === 1;
  });
  const repeated = await submit(fixture.firstRepoPath, 'native-first');
  assert.equal(repeated.jobId, ids[0]);
  assert.equal(repeated.reused, true);
  await writeFile(releasePath, 'go');
  await until('successful completion after release', ids, (states) => states.every((job) => !job.slotHeld && job.state === 'SUCCEEDED'));
  const intervals: { start: number; end: number }[] = [];
  for (const jobId of ids) {
    let stdout = '';
    const exitCode = await runCli(['jobs', 'result', jobId, '--json'], {
      cwd: fixture.root, daemonSocketPath: runtime.paths.socketPath,
      stdout: (text) => { stdout += text; }, stderr: () => {},
    });
    const result = JSON.parse(stdout);
    assert.equal(exitCode, 0, stdout);
    assert.equal(result.ok, true);
    assert.equal(result.data.job.exitCode, 0);
    assert.equal(result.data.job.signal, null);
    assert.equal(result.data.sourceValidity, 'UNCHANGED');
    const logs = await client.request('jobs.logs', { jobId, tail: 100 });
    assert.equal(logs.ok, true);
    const output = (logs.data as { stdout: string }).stdout;
    assert.equal((output.match(/START /g) ?? []).length, 1);
    assert.equal((output.match(/END /g) ?? []).length, 1);
    intervals.push({ start: Number(/START (\d+)/.exec(output)?.[1]), end: Number(/END (\d+)/.exec(output)?.[1]) });
  }
  intervals.sort((a, b) => a.start - b.start);
  assert.ok(intervals[0]!.end <= intervals[1]!.start, JSON.stringify(intervals));
  console.log(JSON.stringify({ detached: true, sharedSlot: true, idempotent: true, resultsVerified: true }));
} finally {
  let safeToRemove = true;
  try { if (connected) {
    // Never delete source paths beneath an unconfirmed process tree after a failing assertion.
    const listing = await client.request('jobs.list', {});
    assert.equal(listing.ok, true, JSON.stringify(listing));
    const jobs = (listing.data as { jobs: JobStatus[] }).jobs;
    for (const job of jobs) if (job.slotHeld || job.state === 'QUEUED') await client.request('jobs.cancel', { jobId: job.jobId });
    try { await until('cleanup', jobs.map((job) => job.jobId), (states) => states.every((job) => !job.slotHeld && job.state !== 'QUEUED'), false); }
    catch { safeToRemove = false; }
  } } catch { safeToRemove = false; }
  finally { try { await client.close(); } finally { await runtime.close(); } }
  if (safeToRemove) { await rm(socketRoot, { recursive: true, force: true }); await fixture.cleanup(); }
  else throw new Error(`Unconfirmed native queue cleanup; fixture retained at ${fixture.root}`);
}

interface JobStatus {
  jobId: string;
  state: JobState;
  slotHeld: boolean;
  stopReason: 'CANCELLED' | 'TIMED_OUT' | 'INTERRUPTED' | null;
  error: string | null;
  exitCode: number | null;
  signal: string | null;
  sourceValidity: SourceValidity;
  waitingReason: JobWaitingReason | null;
  processId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutMs: number;
}
async function status(jobId: string): Promise<JobStatus> {
  const result = await client.request('jobs.status', { jobId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result.data as { job: JobStatus }).job;
}
async function until(
  phase: string,
  ids: string[],
  check: (states: JobStatus[]) => boolean,
  rejectUnsuccessful = true,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const states = await Promise.all(ids.map(status));
    if (rejectUnsuccessful && states.some((job) => !job.slotHeld && !['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(job.state))) {
      throw new Error(`Native queue scenario reached an unsuccessful terminal state (${phase}): ${jobEvidence(states)}`);
    }
    if (check(states)) return;
    if (Date.now() >= deadline) throw new Error(`Native queue scenario deadline exceeded (${phase}): ${jobEvidence(states)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
function jobEvidence(states: JobStatus[]): string {
  // Keep failure evidence explicit: never serialize task argv, environment, or source contents.
  return JSON.stringify(states.map((job) => ({
    jobId: job.jobId, state: job.state, slotHeld: job.slotHeld, stopReason: job.stopReason,
    error: job.error, exitCode: job.exitCode, signal: job.signal, sourceValidity: job.sourceValidity,
    waitingReason: job.waitingReason, processId: job.processId, startedAt: job.startedAt,
    finishedAt: job.finishedAt, timeoutMs: job.timeoutMs,
  })));
}
async function submit(cwd: string, key: string) {
  const childPath = fileURLToPath(new URL('./jobs-submit.scenario.ts', import.meta.url));
  const envelope = await new Promise<JsonEnvelope<unknown>>((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', childPath, runtime.paths.socketPath, cwd, key], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`CLI submission failed (${String(code)}): ${stderr}${stdout}`)); return; }
      try { resolve(JSON.parse(stdout) as JsonEnvelope<unknown>); } catch (error) { reject(error); }
    });
  });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return enqueueAcceptanceSchema.parse(envelope.data);
}
