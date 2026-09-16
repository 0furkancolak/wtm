import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'smol-toml';
import { defaultProductionRuntimePaths } from '../../../daemon/src/runtime-factory';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { DaemonClient } from '../client';
import { runCli } from '../main';
import { createQueueTaskFixture } from './jobs-task-fixture';

/**
 * A daemon started from source exactly the way a contributor starts one —
 * `node --import tsx packages/cli/src/bin.ts daemon serve` — runs a queued job to completion.
 *
 * Nothing here injects a runtime invocation: the daemon composes its own, so its anchor is
 * re-invoked from a `.ts` entry. The test that spawns this file sets an isolated `HOME` (every
 * default path below derives from it) and disables the tsx cache, so a cold loader is what runs.
 */
const home = homedir();
if (home === userInfo().homedir) {
  throw new Error('source daemon scenario requires an isolated temporary HOME');
}
const binPath = fileURLToPath(new URL('../bin.ts', import.meta.url));
const paths = defaultProductionRuntimePaths(home);
const fixture = await createWorkspaceFixture();
const releasePath = join(fixture.userDataDir, 'release');
const taskFixture = createQueueTaskFixture(releasePath);
await writeFile(releasePath, 'go');
await writeFile(join(fixture.root, 'wtm.toml'), stringify({ ...taskFixture.config, workspace: { name: 'workspace with spaces' } }));
for (const [path, contents] of Object.entries(taskFixture.files)) await writeFile(join(fixture.firstRepoPath, path), contents);

const daemon = spawn(process.execPath, ['--import', 'tsx', binPath, 'daemon', 'serve', '--json'], {
  env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonOutput = '';
daemon.stdout.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString(); });
daemon.stderr.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString(); });
const daemonExit = new Promise<void>((resolve) => { daemon.once('close', () => { resolve(); }); });
const client = new DaemonClient({ socketPath: paths.socketPath });
let jobId: string | null = null;
let settled = false;
let connected = false;
try {
  await until('daemon socket', async () => {
    if (daemon.exitCode !== null) throw new Error(`source daemon exited early: ${daemonOutput}`);
    return await lstat(paths.socketPath).then((stat) => stat.isSocket(), () => false);
  });
  await client.start();
  connected = true;
  const initialized = await cli(['init', '--yes', '--json'], fixture.root);
  assert.equal(initialized.code, 0, initialized.stdout);
  const submitted = await cli(['run', 'check', '--enqueue', '--json'], fixture.firstRepoPath);
  assert.equal(submitted.code, 0, submitted.stdout);
  const acceptance = JSON.parse(submitted.stdout) as { ok: boolean; data: { jobId: string } };
  assert.equal(acceptance.ok, true, submitted.stdout);
  jobId = acceptance.data.jobId;
  const id = jobId;
  let last: unknown = null;
  await until('job completion', async () => {
    const result = await client.request('jobs.status', { jobId: id });
    assert.equal(result.ok, true, JSON.stringify(result));
    const job = (result.data as { job: { state: string; slotHeld: boolean; error: string | null } }).job;
    last = job;
    if (!['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(job.state)) {
      throw new Error(`source daemon job did not succeed: ${JSON.stringify(job)}`);
    }
    return job.state === 'SUCCEEDED' && !job.slotHeld;
  }, () => JSON.stringify(last));
  settled = true;
  const result = await cli(['jobs', 'result', id, '--json'], fixture.root);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { data: { job: { exitCode: number | null } } };
  assert.equal(envelope.data.job.exitCode, 0);
  const logs = await client.request('jobs.logs', { jobId: id, tail: 100 });
  assert.equal(logs.ok, true, JSON.stringify(logs));
  const output = (logs.data as { stdout: string }).stdout;
  assert.match(output, /START \d+/);
  assert.match(output, /END \d+/);
  console.log(JSON.stringify({ sourceDaemon: true, jobSucceeded: true, logged: true }));
} finally {
  try {
    if (connected) {
      if (jobId !== null && !settled) await client.request('jobs.cancel', { jobId }).catch(() => undefined);
      await client.close();
    }
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
    const killer = setTimeout(() => { daemon.kill('SIGKILL'); }, 10_000);
    await daemonExit;
    clearTimeout(killer);
    // Never delete a source tree beneath a job whose process tree was not confirmed finished.
    if (jobId === null || settled) await fixture.cleanup();
  }
}

async function cli(argv: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    cwd, daemonSocketPath: paths.socketPath,
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
  });
  return { code, stdout: stdout || stderr };
}

async function until(phase: string, check: () => Promise<boolean>, evidence: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`source daemon scenario deadline exceeded (${phase}) ${evidence()} ${daemonOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
