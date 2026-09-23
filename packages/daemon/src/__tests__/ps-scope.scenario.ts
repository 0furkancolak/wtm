import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { fixtureIpcAddress } from '../../../testkit/src/ipc-address';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { DaemonClient } from '../../../cli/src/client';
import { runCli } from '../../../cli/src/main';
import { createProductionDaemon } from '../runtime-factory';

/**
 * Proves `wtm ps`'s workspace-wide scope excludes a sibling worktree already marked `CLEANING`
 * (`deadWorktreeStates`), the same way `featureGroup` already does, rather than accumulating
 * every worktree the workspace's repository has ever held -- including ones a removal is
 * mid-teardown on, and (since worktree rows are soft-deleted and never purged) ones removed long
 * ago. The registration's own worktree stays visible however it started `wtm ps` -- residual
 * processes on a dying worktree must stay inspectable from inside it -- so this starts a real
 * process on the *sibling* being marked dead and queries `ps` from the other, live worktree.
 */
const fixture = await createWorkspaceFixture();
const socketDirectory = await mkdtemp(join(shortTmpRoot(), 'wtm-socket-'));
const runtime = await createProductionDaemon({
  platformRuntime: selectPlatformRuntime(),
  dataRoot: join(fixture.userDataDir, 'production'),
  socketPath: fixtureIpcAddress(socketDirectory),
  logRoot: join(fixture.userDataDir, 'logs'),
  gracePeriodMs: 100,
  pollIntervalMs: 10,
  runtimeInvocation: developmentRuntimeInvocation(),
});
const client = new DaemonClient({ socketPath: runtime.paths.socketPath });
try {
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '[tasks.hold]',
    'run = ["node", "-e", "setInterval(() => {}, 1000)"]',
    'background = true',
    'singleton = true',
  ].join('\n'));
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'fixture', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: identity.commonGitDir,
    mainRoot: fixture.firstRepoPath,
    remoteIdentity: null,
  });
  runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  await runtime.start();
  await client.start();

  // Start `hold` on the linked worktree -- the sibling this test is about to mark dead -- so its
  // history has a real process record for `ps` to (wrongly, pre-fix) still report.
  const siblingStart = await invoke(fixture.linkedWorktreePath, ['start', 'hold', '--json']);
  if (!siblingStart.envelope.ok) throw new Error(JSON.stringify({ stage: 'sibling-start', ...siblingStart }));
  const siblingProcessId = siblingStart.envelope.data.process.id as string;

  const sibling = runtime.stateStore.listWorktrees(repository.id)
    .find((candidate) => candidate.path === fixture.linkedWorktreePath);
  if (sibling === undefined) throw new Error('linked worktree missing before markWorktreeCleaning');
  runtime.stateStore.markWorktreeCleaning(sibling.id);

  const ps = await invoke(fixture.firstRepoPath, ['ps', '--json']);
  if (!ps.envelope.ok) throw new Error(JSON.stringify({ stage: 'ps', ...ps }));
  const processIds = (ps.envelope.data.processes as Array<{ id: string }>).map(({ id }) => id);

  console.log(JSON.stringify({
    psOk: ps.envelope.ok,
    siblingProcessListed: processIds.includes(siblingProcessId),
  }));

  await client.request('stop', { cwd: fixture.linkedWorktreePath }).catch(() => undefined);
} finally {
  await client.close();
  await runtime.close();
  await rm(socketDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}

async function invoke(cwd: string, argv: string[]) {
  let stdout = '';
  const exitCode = await runCli(argv, {
    cwd,
    runtimeClient: client,
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  return { exitCode, envelope: JSON.parse(stdout) };
}
