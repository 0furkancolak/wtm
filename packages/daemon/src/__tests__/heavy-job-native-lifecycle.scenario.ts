import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listGitWorktrees, readGitRepositoryIdentity, type HeavyJobRecord, type ManagedProcessRecord } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import type { ObservedProcessIdentity } from '@wtm/platform/ports';
import { stringify } from 'smol-toml';
import { DaemonClient } from '../../../cli/src/client';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../runtime-factory';

const mode = process.argv[2];
assert.ok(['cancel', 'timeout', 'restart-running', 'completed-during-downtime'].includes(mode ?? ''));
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-job-life-'));
const platform = selectPlatformRuntime().process;
const options = {
  dataRoot: join(fixture.userDataDir, 'queue'),
  // The Windows publisher and client pass this address directly to node:net.
  socketPath: process.platform === 'win32' ? String.raw`\\.\pipe\wtm-${basename(controls)}` : join(controls, 'wtmd.sock'),
  logRoot: join(fixture.userDataDir, 'logs'), globalConfigPath: join(controls, 'global.toml'),
  runtimeInvocation: developmentRuntimeInvocation(), gracePeriodMs: 500, pollIntervalMs: 25,
};
let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;
let jobId: string | null = null;
let owned: ManagedProcessRecord | null = null;
const childIdentities: ObservedProcessIdentity[] = [];
const records = new Map<string, ManagedProcessRecord>();
const uncertainAnchors = new Set<number>();
let observedExits = new Map<string, Pick<HeavyJobRecord, 'exitCode' | 'signal'>>();

try {
  // Both programs are fingerprinted sources; PID, launch-count, and release markers are outside.
  await writeFile(join(fixture.firstRepoPath, 'queue-lifecycle.cjs'), taskSource());
  await writeFile(join(fixture.root, 'wtm.toml'), stringify({
    version: 1,
    tasks: { lifecycle: { run: ['node', 'queue-lifecycle.cjs', 'parent', controls], queue: true, timeout: mode === 'timeout' ? '5s' : '8s' } },
  }));
  runtime = await createProductionDaemon(options);
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'native-lifecycle', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  await startRuntime();
  const accepted = await queue().enqueue(fixture.firstRepoPath, 'lifecycle', 'native-lifecycle');
  jobId = accepted.jobId;
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reused, false);
  await until('task and descendant started', async () => {
    const job = queue().get(jobId!);
    assert.ok(job.state === 'QUEUED' || job.state === 'RUNNING', evidence(job));
    if (job.state !== 'RUNNING' || job.processId === null) return false;
    if (await readOptional(join(controls, 'parent.pid')) === null || await readOptional(join(controls, 'descendant.pid')) === null) return false;
    return runtime!.stateStore.getManagedProcess(job.processId) !== null;
  });
  owned = runtime.stateStore.getManagedProcess(queue().get(jobId).processId!);
  assert.ok(owned);
  records.set(owned.id, owned);
  assert.equal(queue().get(jobId).slotHeld, true);
  for (const name of ['parent', 'descendant']) {
    const pid = Number((await readFile(join(controls, `${name}.pid`), 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const inspected = await platform.inspectProcess(pid);
    assert.equal(inspected.status, 'present', JSON.stringify(inspected));
    if (inspected.status === 'present') childIdentities.push(inspected.identity);
  }
  const group = await platform.inspectProcessGroup(owned.pgid);
  assert.equal(group.status, 'present', JSON.stringify(group));
  if (group.status === 'present') for (const child of childIdentities) assert.ok(group.pids.includes(child.pid));

  if (mode === 'cancel') {
    const cancellation = await connection().request('jobs.cancel', { jobId });
    assert.equal(cancellation.ok, true, JSON.stringify(cancellation));
  } else if (mode !== 'timeout') {
    await closeRuntime();
    // Closing control handles must leave the acknowledged anchor and both task processes live.
    const anchor = await platform.inspectProcess(owned.pid);
    assert.equal(anchor.status, 'present', JSON.stringify(anchor));
    if (anchor.status === 'present') assert.ok(sameIdentity(anchor.identity, owned));
    for (const identity of childIdentities) {
      const inspected = await platform.inspectProcess(identity.pid);
      assert.equal(inspected.status, 'present', JSON.stringify(inspected));
      if (inspected.status === 'present') assert.ok(sameIdentity(inspected.identity, identity));
    }
    runtime = await createProductionDaemon(options);
    if (mode === 'completed-during-downtime') {
      await writeFile(join(controls, 'release'), 'go');
      await until('durable completion while daemon is stopped', async () => {
        const completion = await runtime!.logs.readCompletion(owned!.stdoutPath, owned!.pid);
        return completion !== null && (await platform.inspectProcessGroup(owned!.pgid)).status === 'absent';
      });
      const completion = await runtime.logs.readCompletion(owned.stdoutPath, owned.pid);
      assert.ok(completion);
      assert.equal(completion.exitCode, 0);
      assert.equal(completion.signal, null);
      assert.equal(completion.timedOut, false);
      assert.equal(queue().get(jobId).state, 'RUNNING');
      assert.equal(queue().get(jobId).slotHeld, true, 'only daemon reconciliation may release the durable slot');
    }
    await startRuntime();
    const repeated = await queue().enqueue(fixture.firstRepoPath, 'lifecycle', 'native-lifecycle');
    assert.equal(repeated.jobId, jobId);
    assert.equal(repeated.reused, true);
  }

  await until('terminal result and released slot', async () => {
    const job = queue().get(jobId!);
    return !job.slotHeld && job.state !== 'QUEUED' && job.state !== 'RUNNING';
  });
  const job = queue().get(jobId);
  const expectedState = mode === 'cancel' ? 'CANCELLED' : mode === 'timeout' ? 'TIMED_OUT'
    : mode === 'restart-running' ? 'INTERRUPTED' : 'SUCCEEDED';
  const expectedError = mode === 'cancel' ? 'USER_CANCELLED' : mode === 'timeout' ? 'TIMEOUT'
    : mode === 'restart-running' ? 'DAEMON_INTERRUPTED' : null;
  assert.equal(job.state, expectedState, evidence(job));
  assert.equal(job.stopReason, expectedState === 'SUCCEEDED' ? null : expectedState);
  assert.equal(job.error, expectedError, evidence(job));
  assert.equal(job.sourceValidity, 'UNCHANGED');
  assert.equal(job.slotHeld, false);
  assert.ok(job.finishedAt !== null);
  assert.deepEqual(await platform.inspectProcessGroup(owned.pgid), { status: 'absent' });
  for (const identity of childIdentities) assert.deepEqual(await platform.inspectProcess(identity.pid), { status: 'absent' });
  const completion = await runtime!.logs.readCompletion(owned.stdoutPath, owned.pid);
  if (process.platform !== 'win32' || mode === 'completed-during-downtime') {
    assert.ok(completion, 'the real anchor must publish the task outcome');
  }
  if (completion !== null) {
    assert.equal(job.exitCode, completion.exitCode, 'stored task exit code must preserve durable evidence');
    assert.equal(job.signal, completion.signal, 'stored task signal must preserve durable evidence');
    assert.equal(completion.timedOut, mode === 'timeout');
  } else {
    // Windows taskkill /T /F can kill the anchor before it publishes task evidence.
    // Preserve the real supervisor observation, or explicit unknowns after recovery.
    const observed = observedExits.get(owned.id) ?? { exitCode: null, signal: null };
    assert.deepEqual({ exitCode: job.exitCode, signal: job.signal }, observed, evidence(job));
  }
  if (mode === 'completed-during-downtime') {
    assert.equal(job.exitCode, 0);
    assert.equal(job.signal, null);
  } else if (process.platform !== 'win32') {
    assert.equal(job.exitCode, null, evidence(job));
    assert.equal(job.signal, 'SIGTERM', evidence(job));
  }
  const result = await connection().request('jobs.result', { jobId });
  assert.equal(result.ok, expectedState === 'SUCCEEDED', JSON.stringify(result));
  if (!result.ok) assert.equal(result.errors[0]?.code, 'WTM_JOB_UNSUCCESSFUL');
  const lateCancellation = await connection().request('jobs.cancel', { jobId });
  assert.equal(lateCancellation.ok, true, JSON.stringify(lateCancellation));
  assert.deepEqual(queue().get(jobId), job, 'a later request must not rewrite terminal state or exit evidence');
  const repeatedResult = await connection().request('jobs.result', { jobId });
  assert.equal(repeatedResult.ok, result.ok, JSON.stringify(repeatedResult));
  assert.deepEqual(repeatedResult.data, result.data);
  const logs = await connection().request('jobs.logs', { jobId, tail: 100 });
  assert.equal(logs.ok, true, JSON.stringify(logs));
  const output = logs.data as { stdout: string; stderr: string };
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.split('\n').filter((line) => line === 'START').length, 1);
  assert.equal(output.stdout.split('\n').filter((line) => line === 'DESCENDANT_START').length, 1);
  assert.equal(output.stdout.split('\n').filter((line) => line === 'END').length, expectedState === 'SUCCEEDED' ? 1 : 0);
  assert.equal(await readFile(join(controls, 'launches'), 'utf8'), 'START\n', 'restart must never replay the task');
  console.log(JSON.stringify({ mode, state: job.state, error: job.error, groupAbsent: true, sourceValidity: job.sourceValidity, launches: 1, terminalImmutable: true }));
} finally {
  let safe = true;
  try { await closeRuntime(); } catch { safe = false; }
  for (const record of records.values()) {
    try {
      const group = await platform.inspectProcessGroup(record.pgid);
      if (group.status === 'absent') continue;
      const inspected = await platform.inspectProcess(record.pid);
      if (group.status === 'failed' || inspected.status !== 'present' || !sameIdentity(inspected.identity, record)) {
        safe = false;
        continue;
      }
      platform.signalProcessGroup(record.pgid, 'SIGKILL');
      await until('fixture process-group cleanup', async () => (await platform.inspectProcessGroup(record.pgid)).status === 'absent');
    } catch { safe = false; }
  }
  for (const pid of uncertainAnchors) {
    try { if ((await platform.inspectProcessGroup(pid)).status !== 'absent') safe = false; }
    catch { safe = false; }
  }
  for (const identity of childIdentities) {
    try {
      const inspected = await platform.inspectProcess(identity.pid);
      // A missing intermediate parent can hide a remaining descendant from a tree scan.
      // Reused PIDs are never signalled; an owned survivor or uncertain identity retains files.
      if (inspected.status === 'failed' || (inspected.status === 'present' && sameIdentity(inspected.identity, identity))) safe = false;
    } catch { safe = false; }
  }
  if (!safe) throw new Error(`Native job lifecycle cleanup is unconfirmed; fixture retained at ${fixture.root}`);
  await rm(controls, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  await fixture.cleanup();
}

function queue() {
  assert.ok(runtime?.jobs);
  return runtime.jobs;
}
function connection() {
  assert.ok(client);
  return client;
}
async function startRuntime() {
  assert.ok(runtime);
  assert.ok(runtime.jobs);
  const observations = new Map<string, Pick<HeavyJobRecord, 'exitCode' | 'signal'>>();
  observedExits = observations;
  const forwardExit = runtime.jobs.recordExit.bind(runtime.jobs);
  // Observe the unchanged, real supervisor callback; never invent a task exit or process identity.
  runtime.jobs.recordExit = (record, outcome) => {
    observations.set(record.id, { exitCode: outcome.exitCode, signal: outcome.signal });
    forwardExit(record, outcome);
  };
  await runtime.start();
  client = new DaemonClient({ socketPath: runtime.paths.socketPath });
  await client.start();
}
async function closeRuntime() {
  if (runtime !== null) {
    // Stop dispatch before snapshotting identities: no job can begin beneath fixture cleanup.
    await runtime.jobs?.close();
    if (jobId !== null && runtime.jobs !== null) {
      const job = runtime.jobs.get(jobId);
      if (job.anchorPid !== null) uncertainAnchors.add(job.anchorPid);
    }
    for (const record of runtime.stateStore.listManagedProcesses()) records.set(record.id, record);
  }
  try { await client?.close(); }
  finally { client = null; if (runtime !== null) { await runtime.close(); runtime = null; } }
}
async function until(phase: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Native lifecycle deadline (${phase}): ${jobId !== null && runtime?.jobs ? evidence(runtime.jobs.get(jobId)) : 'daemon stopped'}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function sameIdentity(left: ObservedProcessIdentity, right: ObservedProcessIdentity) {
  return left.pid === right.pid && left.pgid === right.pgid && left.processStartTime === right.processStartTime
    && left.commandFingerprint === right.commandFingerprint;
}
function evidence(job: HeavyJobRecord) {
  return JSON.stringify({ state: job.state, slotHeld: job.slotHeld, stopReason: job.stopReason, error: job.error,
    exitCode: job.exitCode, signal: job.signal, sourceValidity: job.sourceValidity });
}
function taskSource() {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const role = process.argv[2];
const controls = process.argv[3];
const ready = () => fs.writeFileSync(path.join(controls, role + '.pid'), String(process.pid));
if (role === 'descendant') {
  // Cancellation is allowed only after the initial log write has reached the pipe.
  process.stdout.write('DESCENDANT_START\n', ready);
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(controls, 'release'))) return;
    clearInterval(timer);
    console.log('DESCENDANT_END');
  }, 25);
} else {
  fs.appendFileSync(path.join(controls, 'launches'), 'START\n');
  process.stdout.write('START\n', ready);
  const child = spawn(process.execPath, [__filename, 'descendant', controls], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    if (code === 0 && signal === null) console.log('END');
    else process.exitCode = 1;
  });
}
`;
}
