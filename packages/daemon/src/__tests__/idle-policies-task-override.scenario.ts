import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readGitRepositoryIdentity, listGitWorktrees } from '@wtm/core';
import { stringify } from 'smol-toml';
import { createProductionDaemon, readIdlePolicies } from '../runtime-factory';

/**
 * Regression for the merge-audit finding on the idle-suspension sweep (PRs #50/#51 interaction):
 * `readIdlePolicies` used to read `wtm.toml`'s `[tasks.<name>.idle]` block directly, bypassing
 * `wtm task set` overrides entirely. Per `applyTaskOverrides`'s own contract, an override is a
 * whole replacement of a task's definition — and the wire schema has no `idle` field an override
 * could carry — so a worktree with an active override for a task must see *no* idle policy for
 * that task name, exactly as `task-resolution.ts`'s real start/restart path already would.
 */
const root = await mkdtemp(join(tmpdir(), 'wtm-idle-override-'));
try {
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repoPath, 'wtm.toml'), stringify({
    version: 1,
    workspace: { name: 'idle-override-fixture' },
    tasks: { dev: { run: ['node', '-e', "setInterval(() => {}, 1000)"], idle: { enabled: true, timeout: '30m' } } },
  }));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  const dataRoot = join(root, 'daemon');
  const runtime = await createProductionDaemon({
    dataRoot,
    socketPath: join(root, 'wtmd.sock'),
    logRoot: join(root, 'logs'),
    globalConfigPath: join(root, 'global.toml'),
  });
  try {
    const workspace = runtime.stateStore.upsertWorkspace({
      name: 'idle-override-fixture', root: repoPath, scope: 'local', configPath: join(repoPath, 'wtm.toml'),
    });
    const identity = await readGitRepositoryIdentity(repoPath);
    const repository = runtime.stateStore.upsertRepository({
      workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: repoPath, remoteIdentity: null,
    });
    runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(repoPath));
    const worktree = runtime.stateStore.listWorktrees(repository.id)[0];
    assert.ok(worktree, 'expected the main worktree to be discovered');

    const beforeOverride = await readIdlePolicies(runtime.stateStore, runtime.paths.globalConfigPath, worktree.id);
    assert.ok(beforeOverride.has('dev'), 'the file-declared idle policy must be visible with no override in place');

    assert.ok(runtime.stateStore.taskOverrides, 'expected a task-overrides store on the production state store');
    runtime.stateStore.taskOverrides.set({
      worktreeId: worktree.id, taskName: 'dev',
      task: { run: ['node', '-e', "setInterval(() => {}, 1000)", '--debug'] },
      now: new Date().toISOString(),
    });

    const afterOverride = await readIdlePolicies(runtime.stateStore, runtime.paths.globalConfigPath, worktree.id);
    process.stdout.write(`${JSON.stringify({
      idleVisibleBeforeOverride: beforeOverride.has('dev'),
      idleVisibleAfterOverride: afterOverride.has('dev'),
    })}\n`);
  } finally {
    await runtime.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
