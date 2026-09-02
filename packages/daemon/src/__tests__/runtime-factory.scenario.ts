import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { DaemonClient } from '../../../cli/src/client';
import { runCli } from '../../../cli/src/main';
import { createProductionDaemon } from '../runtime-factory';

const fixture = await createWorkspaceFixture();
const socketDirectory = await mkdtemp('/tmp/wtm-socket-');
const useDefaultClient = process.argv[2] === 'default-client';
const closeWithLiveTask = process.argv[2] === 'close-live';
const runtimeInvocation = developmentRuntimeInvocation();
const runtime = await createProductionDaemon(useDefaultClient ? {
  gracePeriodMs: 100,
  pollIntervalMs: 10,
  runtimeInvocation,
} : {
  dataRoot: join(fixture.userDataDir, 'production'),
  socketPath: join(socketDirectory, 'wtmd.sock'),
  logRoot: join(fixture.userDataDir, 'logs'),
  gracePeriodMs: 100,
  pollIntervalMs: 10,
  runtimeInvocation,
});
const client = new DaemonClient({ socketPath: runtime.paths.socketPath });
try {
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    '[tasks.hold]',
    closeWithLiveTask
      ? 'run = ["/bin/sleep", "30"]'
      : 'run = ["node", "-e", "setInterval(() => {}, 1000)"]',
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
  if (!useDefaultClient) await client.start();

  const start = await invoke(['start', 'hold', '--json']);
  if (!start.envelope.ok) throw new Error(JSON.stringify(start.envelope));
  if (closeWithLiveTask) {
    await runtime.close();
    const processRecord = start.envelope.data.process;
    console.log(JSON.stringify({
      startExit: start.exitCode,
      startState: processRecord.state,
      identity: {
        pid: processRecord.pid,
        pgid: processRecord.pgid,
        processStartTime: processRecord.processStartTime,
        commandFingerprint: processRecord.commandFingerprint,
      },
    }));
  } else {
    const ps = await invoke(['ps', '--json']);
    const stop = await invoke(['stop', 'hold', '--json']);
    console.log(JSON.stringify({
      startExit: start.exitCode,
      startState: start.envelope.data.process.state,
      psRunning: ps.envelope.data.processes.some((process: { taskName: string; state: string }) =>
        process.taskName === 'hold' && process.state === 'RUNNING'),
      stopExit: stop.exitCode,
      stopState: stop.envelope.data.processes[0].state,
      // Reported only by the default-client run, because that is the only one whose socket is
      // derived rather than handed in — the others would be reading back their own argument. The
      // test that spawned this asserts the address landed inside the temporary home, which is the
      // claim `HOME` isolation makes and the one that stops holding on Linux the moment the XDG
      // variables are left ambient.
      ...(useDefaultClient ? { socketPath: runtime.paths.socketPath } : {}),
    }));
  }
} finally {
  await client.close();
  await runtime.close();
  await rm(socketDirectory, { recursive: true, force: true });
  await fixture.cleanup();
}

async function invoke(argv: string[]) {
  let stdout = '';
  const exitCode = await runCli(argv, {
    cwd: fixture.firstRepoPath,
    ...(useDefaultClient ? {} : { runtimeClient: client }),
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  return { exitCode, envelope: JSON.parse(stdout) };
}
