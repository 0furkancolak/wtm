import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SQLiteStateStore, initializeWorkspace, resolveTask } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import {
  execEnvironment,
  featureGroup,
  resolveWorktreeRuntime,
  taskResolutionInput,
} from '../task-resolution';

const execFileAsync = promisify(execFile);
const branch = 'feature/existing';

const fixture = await createWorkspaceFixture();
// The second repository's worktree on the same branch: the other half of one feature.
const secondWorktree = join(fixture.root, 'linked second worktree');
const stateDirectory = join(fixture.userDataDir, 'state');
const globalConfigPath = join(fixture.userDataDir, 'config.toml');
let store: SQLiteStateStore | null = null;

try {
  await execFileAsync('git', ['-C', fixture.secondRepoPath, 'worktree', 'add', '-b', branch, secondWorktree]);
  await writeFile(join(secondWorktree, '.env.example'), 'CORS_ORIGINS=\n');
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '',
    '[workspace]',
    'name = "workspace with spaces"',
    '',
    '[ports]',
    'range = "31000-31099"',
    '',
    '[ports.api]',
    'env = "PORT"',
    '',
    '[ports.web]',
    'preferred = 31050',
    '',
    '[environment]',
    'API_URL = "http://localhost:{port.api}"',
    'BRANCH = "{branch}"',
    '',
    '[repos.first-repo]',
    'path = "services/first repo"',
    '',
    '[repos.first-repo.environment]',
    'PORT = "{port.api}"',
    '',
    '[repos.second-repo]',
    'path = "tools/second-repo"',
    '',
    '[repos.second-repo.environment]',
    'PORT = "{port.web}"',
    '',
    '[tasks.serve]',
    'run = ["node", "server.js"]',
  ].join('\n'));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  store = new SQLiteStateStore(join(stateDirectory, 'state.db'));
  await initializeWorkspace({ root: fixture.root, userDataDir: fixture.userDataDir, stateStore: store });

  const openStore = store;
  const runtimeAt = (cwd: string) => resolveWorktreeRuntime({
    store: openStore,
    cwd,
    globalConfigPath,
    probe: () => true,
  });

  const nested = join(fixture.linkedWorktreePath, 'src');
  await mkdir(nested, { recursive: true });

  const first = await runtimeAt(fixture.linkedWorktreePath);
  const fromNested = await runtimeAt(nested);
  const second = await runtimeAt(secondWorktree);
  const main = await runtimeAt(fixture.firstRepoPath);
  const task = resolveTask(taskResolutionInput(first, 'serve'));
  const featurePort = first.context.ports?.api as number;
  const webPort = first.context.ports?.web as number;
  const firstEnvironment = execEnvironment(first);
  const secondEnvironment = execEnvironment(second);

  let unregistered = 'resolved';
  try {
    await runtimeAt(fixture.userDataDir);
  } catch (error) {
    unregistered = error instanceof Error ? error.message : String(error);
  }

  process.stdout.write(`${JSON.stringify({
    // The repositories sit two directories below the root, so a resolution that looked for
    // `wtm.toml` beside the worktree would find none of this.
    workspaceTaskVisible: first.config.tasks?.serve?.run ?? null,
    workspaceRoot: first.context.workspace?.root === fixture.root,
    workspaceMakefileTask: first.config.tasks?.['workspace:dev']?.run ?? null,
    branch: first.context.branch,
    nestedResolvesToWorktree: fromNested.registration.worktree.path === fixture.linkedWorktreePath,
    featureGroup: featureGroup(openStore, first.registration).map(({ path }) => path).sort(),
    portInRange: featurePort >= 31_000 && featurePort <= 31_099,
    sharedAcrossRepositories: second.context.ports?.api === featurePort,
    separateFromOtherFeature: main.context.ports?.api !== featurePort,
    publishedEnvironment: {
      API_URL: secondEnvironment.API_URL === `http://localhost:${featurePort}`,
      BRANCH: secondEnvironment.BRANCH,
      CORS_ORIGINS: secondEnvironment.CORS_ORIGINS === `http://localhost:${featurePort},http://localhost:${webPort}`,
    },
    // Both repositories read PORT, and each one means the endpoint of its own service.
    perRepositoryPort: {
      api: firstEnvironment.PORT === String(featurePort),
      web: secondEnvironment.PORT === String(webPort),
      distinct: featurePort !== webPort,
    },
    task: { argv: task.argv, cwd: task.cwd === fixture.linkedWorktreePath, port: task.envDelta.PORT === String(featurePort) },
    unregistered,
  }, null, 0)}\n`);
} finally {
  store?.close();
  await rm(stateDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}
