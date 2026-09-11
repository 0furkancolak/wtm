import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stringify } from 'smol-toml';
import { readGitRepositoryIdentity, listGitWorktrees } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { createProductionDaemon } from '../runtime-factory';

const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-mem-'));
let runtime: Awaited<ReturnType<typeof createProductionDaemon>> | undefined;
try {
  const globalConfigPath = join(fixture.userDataDir, 'global.toml');
  await writeFile(globalConfigPath, stringify({ jobs: { max_concurrent_heavy: 4, memory: { budget_mib: 8, reserve_mib: 0 } } }));
  const configPath = join(fixture.root, 'wtm.toml');
  await writeFile(configPath, stringify({
    // A repository cannot raise the shared host limit.
    jobs: { memory: { budget_mib: 128, reserve_mib: 0 } },
    tasks: {
      check: { run: ['node', '-e', 'void 0', '{env.QUEUE_WORKERS}'], queue: true, timeout: '1m', memory_estimate_mib: 1, queue_env: { QUEUE_WORKERS: '2' } },
      large: { run: ['node', '-e', 'void 0'], queue: true, timeout: '1m', memory_estimate_mib: 9 },
      missing: { run: ['node', '-e', 'void 0'], queue: true, timeout: '1m' },
    },
  }));
  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'queue'), globalConfigPath,
    // macOS's canonical temp workspace path can exceed sun_path before any socket is opened.
    socketPath: process.platform === 'win32' ? String.raw`\\.\pipe\wtm-memory-${basename(controls)}` : join(controls, 'd.sock'),
  });
  const workspace = runtime.stateStore.upsertWorkspace({ name: 'memory', root: fixture.root, scope: 'local', configPath });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repo = runtime.stateStore.upsertRepository({ workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null });
  runtime.stateStore.reconcileWorktrees(repo.id, await listGitWorktrees(fixture.firstRepoPath));
  assert.ok(runtime.jobs);
  // Deliberately do not start the daemon: this proves composition/admission without claiming
  // native IPC or process execution evidence, and no command can be launched by the fixture.
  const accepted = await runtime.jobs.enqueue(fixture.firstRepoPath, 'check', 'accepted');
  assert.equal(accepted.accepted, true);
  assert.equal(runtime.jobs.get(accepted.jobId).memoryEstimateBytes, 1024 * 1024);
  assert.equal(runtime.jobs.get(accepted.jobId).state, 'QUEUED');
  await assert.rejects(runtime.jobs.enqueue(fixture.firstRepoPath, 'large', 'large'), { code: 'WTM_JOB_MEMORY_BUDGET_EXCEEDED' });
  await assert.rejects(runtime.jobs.enqueue(fixture.firstRepoPath, 'missing', 'missing'), { code: 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED' });
  console.log(JSON.stringify({ ok: true }));
} finally { await runtime?.close(); await fixture.cleanup(); await rm(controls, { recursive: true, force: true }); }
