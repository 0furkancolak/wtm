import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stringify } from 'smol-toml';
import { protocolVersion } from '@wtm/protocol';
import { readGitRepositoryIdentity, listGitWorktrees } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { createProductionDaemon } from '../runtime-factory';

const mode = process.argv[2];
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-budgets-'));
let runtime: Awaited<ReturnType<typeof createProductionDaemon>> | undefined;
try {
  const globalConfigPath = join(fixture.userDataDir, 'global.toml');
  await writeFile(globalConfigPath, stringify({
    budgets: mode === 'memory'
      ? { min_available_memory_mib: 1024 * 1024 }
      : { max_processes: 1 },
  }));
  const configPath = join(fixture.root, 'wtm.toml');
  await writeFile(configPath, stringify({
    tasks: { dev: { run: ['node', '-e', 'void 0'], background: true, singleton: true } },
  }));
  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'budgets'), globalConfigPath,
    socketPath: process.platform === 'win32' ? String.raw`\\.\pipe\wtm-budgets-${basename(controls)}` : join(controls, 'd.sock'),
  });
  const workspace = runtime.stateStore.upsertWorkspace({ name: 'budgets', root: fixture.root, scope: 'local', configPath });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repo = runtime.stateStore.upsertRepository({ workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null });
  runtime.stateStore.reconcileWorktrees(repo.id, await listGitWorktrees(fixture.firstRepoPath));
  const [worktree] = runtime.stateStore.listWorktrees();
  assert.ok(worktree);
  if (mode === 'process') {
    // Occupies the one-process budget with an unrelated task, so `dev` (never started) is
    // refused by the count alone, not because it is "already active" itself.
    runtime.stateStore.createManagedProcess({
      worktreeId: worktree.id, taskName: 'other', pid: 999_999, pgid: 999_999,
      processStartTime: 'fixture', commandFingerprint: 'fixture',
      state: 'RUNNING', startedAt: new Date().toISOString(), stoppedAt: null,
      stdoutPath: join(controls, 'other.stdout.log'), stderrPath: join(controls, 'other.stderr.log'),
    });
  }
  // Deliberately never calls `runtime.start()` or spawns anything: a budget refusal happens
  // before `ManagedProcessSupervisor.start` is ever reached, so this proves the global-config
  // read and the controller wiring, not process/IPC behaviour (that is `runtime-factory.scenario.ts`).
  const envelope = await runtime.controller.handle({
    protocol: protocolVersion,
    id: 'request-1',
    command: 'start',
    arguments: { cwd: fixture.firstRepoPath, taskName: 'dev' },
  });
  assert.equal(envelope.ok, false);
  assert.equal(
    (envelope as { errors: Array<{ code: string }> }).errors[0]?.code,
    mode === 'memory' ? 'RUNTIME_MEMORY_BUDGET_EXCEEDED' : 'RUNTIME_PROCESS_BUDGET_EXCEEDED',
  );
  console.log(JSON.stringify({ ok: true }));
} finally { await runtime?.close(); await fixture.cleanup(); await rm(controls, { recursive: true, force: true }); }
