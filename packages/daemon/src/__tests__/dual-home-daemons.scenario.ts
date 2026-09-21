import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { containsPath, listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { isolatedHomeEnvironment } from '../../../testkit/src/isolated-home';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture, type WorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { DaemonClient } from '../../../cli/src/client';
import { runCli } from '../../../cli/src/main';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../runtime-factory';

/**
 * 35d: two accounts on one machine, each running `wtm` under their own `HOME`, at the same time.
 *
 * Nothing before this pinned that as a real, running guarantee rather than a property of pure path
 * derivation. `runtime-custom-paths.test.ts` already proves two data roots resolve to two socket
 * addresses; `isolated-home.test.ts` proves two `HOME`s resolve to two `platformPathsFor` results.
 * Neither starts a daemon. This scenario runs two full `createProductionDaemon` runtimes
 * concurrently -- two real SQLite state stores, two real IPC servers, two real structural watchers
 * -- built the same way production builds one, from nothing but a distinct `HOME` through
 * `selectPlatformRuntime`, and proves the second daemon's existence changes nothing about the
 * first: distinct paths, no visibility into the other's workspaces or processes, and an
 * independent lifecycle (closing one leaves the other answering).
 */
async function startHome(home: string, fixture: WorkspaceFixture, taskName: string): Promise<{
  runtime: ProductionDaemonRuntime;
  client: DaemonClient;
  fixture: WorkspaceFixture;
  taskName: string;
}> {
  const platformRuntime = selectPlatformRuntime({ home, env: isolatedHomeEnvironment(home) });
  const runtime = await createProductionDaemon({
    platformRuntime, runtimeInvocation: developmentRuntimeInvocation(), gracePeriodMs: 100, pollIntervalMs: 10,
  });
  const client = new DaemonClient({ socketPath: runtime.paths.socketPath });
  await writeFile(join(fixture.root, 'wtm.toml'), [
    'version = 1',
    `[tasks.${taskName}]`,
    'run = ["node", "-e", "setInterval(() => {}, 1000)"]',
    'background = true',
    'singleton = true',
  ].join('\n'));
  const workspace = runtime.stateStore.upsertWorkspace({
    name: taskName, root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  runtime.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  return { runtime, client, fixture, taskName };
}

async function ps(entry: { runtime: ProductionDaemonRuntime; client: DaemonClient; fixture: WorkspaceFixture }) {
  let stdout = '';
  const exitCode = await runCli(['ps', '--json'], {
    cwd: entry.fixture.firstRepoPath, runtimeClient: entry.client,
    stdout: (text) => { stdout += text; }, stderr: () => {},
  });
  const envelope = JSON.parse(stdout);
  assert.equal(exitCode, 0, stdout);
  assert.equal(envelope.ok, true, stdout);
  return envelope.data.processes as { taskName: string; state: string }[];
}

const root = await mkdtemp(join(shortTmpRoot(), 'wtm-dual-home-'));
const homeAlice = join(root, 'alice');
const homeBob = join(root, 'bob');
let alice: Awaited<ReturnType<typeof startHome>> | undefined;
let bob: Awaited<ReturnType<typeof startHome>> | undefined;
try {
  const [fixtureAlice, fixtureBob] = await Promise.all([createWorkspaceFixture(), createWorkspaceFixture()]);
  try {
    [alice, bob] = await Promise.all([
      startHome(homeAlice, fixtureAlice, 'hold-alice'),
      startHome(homeBob, fixtureBob, 'hold-bob'),
    ]);

    // Distinct HOMEs never resolve onto one another's files. Not merely different strings: neither
    // root sits inside the other's home, which a coincidental shared parent (both under the same
    // `shortTmpRoot()`) would not otherwise rule out.
    assert.notEqual(alice.runtime.paths.dataRoot, bob.runtime.paths.dataRoot);
    assert.notEqual(alice.runtime.paths.socketPath, bob.runtime.paths.socketPath);
    assert.notEqual(alice.runtime.paths.logRoot, bob.runtime.paths.logRoot);
    assert.ok(containsPath(homeAlice, alice.runtime.paths.dataRoot));
    assert.ok(containsPath(homeBob, bob.runtime.paths.dataRoot));
    assert.ok(!containsPath(homeAlice, bob.runtime.paths.dataRoot));
    assert.ok(!containsPath(homeBob, alice.runtime.paths.dataRoot));

    // Both come up and answer at the same time -- not one after the other's has already closed.
    await Promise.all([alice.runtime.start(), bob.runtime.start()]);
    await Promise.all([alice.client.start(), bob.client.start()]);
    const [pingAlice, pingBob] = await Promise.all([
      alice.client.request('ping', {}), bob.client.request('ping', {}),
    ]);
    assert.equal(pingAlice.ok, true);
    assert.equal(pingBob.ok, true);

    // A task started under one HOME is invisible to the other's `ps`, and starting both at once
    // does not cross-schedule either onto the wrong daemon.
    const [startAlice, startBob] = await Promise.all([
      runCli(['start', 'hold-alice', '--json'], {
        cwd: alice.fixture.firstRepoPath, runtimeClient: alice.client,
        stdout: () => {}, stderr: () => {},
      }),
      runCli(['start', 'hold-bob', '--json'], {
        cwd: bob.fixture.firstRepoPath, runtimeClient: bob.client,
        stdout: () => {}, stderr: () => {},
      }),
    ]);
    assert.equal(startAlice, 0);
    assert.equal(startBob, 0);

    const [psAlice, psBob] = await Promise.all([ps(alice), ps(bob)]);
    assert.ok(psAlice.some((process) => process.taskName === 'hold-alice' && process.state === 'RUNNING'), JSON.stringify(psAlice));
    assert.ok(!psAlice.some((process) => process.taskName === 'hold-bob'), JSON.stringify(psAlice));
    assert.ok(psBob.some((process) => process.taskName === 'hold-bob' && process.state === 'RUNNING'), JSON.stringify(psBob));
    assert.ok(!psBob.some((process) => process.taskName === 'hold-alice'), JSON.stringify(psBob));

    const [stopAlice, stopBob] = await Promise.all([
      runCli(['stop', 'hold-alice', '--json'], {
        cwd: alice.fixture.firstRepoPath, runtimeClient: alice.client,
        stdout: () => {}, stderr: () => {},
      }),
      runCli(['stop', 'hold-bob', '--json'], {
        cwd: bob.fixture.firstRepoPath, runtimeClient: bob.client,
        stdout: () => {}, stderr: () => {},
      }),
    ]);
    assert.equal(stopAlice, 0);
    assert.equal(stopBob, 0);

    // Independent lifecycle: closing Alice's daemon leaves Bob's fully live, not merely
    // unaffected in state -- still reachable over its own socket after the other one is gone.
    await alice.client.close();
    await alice.runtime.close();
    const pingAfterAliceClosed = await bob.client.request('ping', {});
    assert.equal(pingAfterAliceClosed.ok, true);
    alice = undefined;

    console.log(JSON.stringify({
      isolatedPaths: true, simultaneouslyLive: true, taskIsolation: true, independentLifecycle: true,
    }));
  } finally {
    await Promise.all([fixtureAlice.cleanup(), fixtureBob.cleanup()]);
  }
} finally {
  if (alice !== undefined) { await alice.client.close().catch(() => {}); await alice.runtime.close().catch(() => {}); }
  if (bob !== undefined) { await bob.client.close().catch(() => {}); await bob.runtime.close().catch(() => {}); }
  await rm(root, { recursive: true, force: true });
}
