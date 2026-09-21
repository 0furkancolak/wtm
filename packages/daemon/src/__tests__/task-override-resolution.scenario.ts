import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLiteStateStore, initializeWorkspace, resolveTask } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { resolveWorktreeRuntime, taskResolutionInput } from '../task-resolution';

const fixture = await createWorkspaceFixture();
const stateDirectory = join(fixture.userDataDir, 'state');
const globalConfigPath = join(fixture.userDataDir, 'config.toml');
let store: SQLiteStateStore | null = null;

try {
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '',
    '[workspace]',
    'name = "workspace with spaces"',
    '',
    '[tasks.serve]',
    'run = ["node", "server.js"]',
    'background = true',
    '',
    '[tasks.build]',
    'run = "npm run build"',
    'shell = true',
  ].join('\n'));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  store = new SQLiteStateStore(join(stateDirectory, 'state.db'));
  await initializeWorkspace({ root: fixture.root, userDataDir: fixture.userDataDir, stateStore: store });

  const openStore = store;
  const runtimeAt = () => resolveWorktreeRuntime({ store: openStore, cwd: fixture.linkedWorktreePath, globalConfigPath, probe: () => true });

  const worktreeId = openStore.listWorktrees().find(({ path }) => path === fixture.linkedWorktreePath)!.id;

  const beforeOverride = await runtimeAt();
  const beforeTask = resolveTask(taskResolutionInput(beforeOverride, 'serve'));

  // Replaces the file-defined `serve` task wholesale (`background` is left out) and adds a task
  // `wtm.toml` never defined at all.
  openStore.taskOverrides.set({
    worktreeId, taskName: 'serve', now: '2026-09-21T12:00:00.000Z',
    task: { run: ['node', 'server.js', '--override'] },
  });
  openStore.taskOverrides.set({
    worktreeId, taskName: 'only-in-db', now: '2026-09-21T12:00:00.000Z',
    task: { run: 'echo db-only', shell: true },
  });

  const afterOverride = await runtimeAt();
  const overriddenTask = resolveTask(taskResolutionInput(afterOverride, 'serve'));
  const dbOnlyTask = resolveTask(taskResolutionInput(afterOverride, 'only-in-db'));
  const buildTask = resolveTask(taskResolutionInput(afterOverride, 'build'));

  openStore.taskOverrides.deleteForWorktree(worktreeId);
  const afterDelete = await runtimeAt();
  const afterDeleteTask = resolveTask(taskResolutionInput(afterDelete, 'serve'));

  process.stdout.write(`${JSON.stringify({
    beforeArgv: beforeTask.argv,
    beforeBackground: beforeTask.background,
    beforeProvenance: beforeOverride.provenance.get('tasks.serve.run')?.source,
    overriddenArgv: overriddenTask.argv,
    // `background` was not in the replacement, so it falls back to the resolver's own default
    // rather than surviving from the file-defined task: a whole replacement, not a merge.
    overriddenBackground: overriddenTask.background,
    overriddenProvenance: afterOverride.provenance.get('tasks.serve.run')?.source,
    overriddenBackgroundProvenance: afterOverride.provenance.get('tasks.serve.background'),
    dbOnlyArgv: dbOnlyTask.argv,
    buildStillFromFile: buildTask.argv,
    afterDeleteArgv: afterDeleteTask.argv,
    afterDeleteProvenance: afterDelete.provenance.get('tasks.serve.run')?.source,
  }, null, 0)}\n`);
} finally {
  store?.close();
  await rm(stateDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}
