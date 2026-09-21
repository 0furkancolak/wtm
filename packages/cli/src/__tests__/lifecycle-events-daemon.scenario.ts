import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { stringify } from 'smol-toml';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../../../daemon/src/runtime-factory';
import { DaemonClient } from '../client';
import { runCli } from '../main';

/**
 * `docs/03-configuration-spec.md` documents eight lifecycle events. Before this scenario, exactly
 * one of them (`worktree.created`) had ever been proven against a *real, running* daemon
 * (`create-daemon-running.scenario.ts`, item 35a's own todo.md entry) -- every other event name
 * was only exercised against `LifecycleEventDispatcher`'s fake harness in `events.test.ts` (a fake
 * `store` and a fake `start` that only records its input -- no real supervisor, no real socket, no
 * real reconcile). `runtime-factory.ts` wires every one of them into production exactly the same
 * way it wires `worktree.created` (`events.onReconciled` for the registration/discovery/removal
 * events, `onRuntimeEvent`/`dispatchForWorktree` for the two runtime ones), so nothing here is new
 * production code -- this closes the same kind of gap PR #11 closed for `worktree.created`, for
 * the remaining seven.
 *
 * One daemon, one repository (`createWorkspaceFixture` already gives it a linked worktree on
 * `feature/existing`, so a second worktree exists without this scenario creating one):
 *
 * - the very first `reconcile` is simultaneously the first reconcile of this workspace and this
 *   repository, and discovers both worktrees for the first time, so it alone proves
 *   `[events."workspace.discovered"]`, `[events."repo.discovered"]` and
 *   `[events."worktree.discovered"]` -- each one's own marker task actually runs -- and, with
 *   `[prepare] mode = "eager"` set from the start, `[events."worktree.ready"]` too, once resource
 *   preparation completes without any task having been run in the worktree yet;
 * - `wtm start dev` (no `--wait`) starts a real long-lived process through the real supervisor,
 *   proving `[events."runtime.started"]` -- `mark-started` -- actually runs;
 * - `wtm stop dev` proves `[events."runtime.stopped"]` -- `mark-stopped` -- actually runs, and that
 *   the process the daemon reports stopped is truly gone from the OS;
 * - removing the linked worktree with a raw `git worktree remove` (not `wtm remove`, which is a
 *   different unit's territory and does not itself dispatch anything -- the daemon's next
 *   reconcile does) and then reconciling proves `[events."worktree.removed"]` -- `mark-removed` --
 *   actually runs, in the *main* worktree, exactly as documented.
 *
 * Every marker task's script only exists in the main worktree (`fixture.firstRepoPath`), committed
 * before either worktree is ever reconciled; the linked worktree (`feature/existing`) branched off
 * before that commit, so its own copy of each once-only event (`worktree.discovered`,
 * `worktree.ready`) fails to find the script and is left to fail harmlessly (a dispatcher failure
 * never fails the reconcile that raised it -- see `events.ts`'s own doc comment) rather than
 * standing up a second, divergent fixture checkout just to give it one too.
 */
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-lifecycle-events-'));
const configPath = join(fixture.root, 'wtm.toml');
const taskTargetDatabasePath = join(controls, 'task-target-state.db');
const taskTargetGlobalConfigPath = join(controls, 'task-target-global.toml');
const platform = selectPlatformRuntime().process;

let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;
let worktreeId: string | null = null;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: { ok: boolean; data: any; warnings: Array<{ code: string }>; errors: Array<{ code: string }> };
}

async function invoke(argv: string[]): Promise<Invocation> {
  assert.ok(client);
  let out = '';
  let err = '';
  const code = await runCli([...argv, '--json'], {
    cwd: fixture.firstRepoPath,
    analysisDatabasePath: runtime!.paths.databasePath,
    daemonSocketPath: runtime!.paths.socketPath,
    runtimeClient: client,
    taskTargetDatabasePath,
    taskTargetGlobalConfigPath,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

/** Polls for a filesystem/process side effect that happens asynchronously off the daemon. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  deadlineMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const markerPath = (name: string) => join(fixture.firstRepoPath, name);

try {
  // Tracked files, so both the main worktree and the fixture's pre-existing linked worktree
  // already have them at HEAD before the daemon (or `git worktree remove`) ever touches them.
  await writeFile(join(fixture.firstRepoPath, 'dev.cjs'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(process.cwd(), 'dev.pid'), String(process.pid));",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  await writeFile(join(fixture.firstRepoPath, 'mark.cjs'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(process.cwd(), process.argv[2]), 'x');",
    '',
  ].join('\n'));
  git(fixture.firstRepoPath, 'add', 'dev.cjs', 'mark.cjs');
  git(fixture.firstRepoPath, 'commit', '-m', 'Add lifecycle-event marker tasks');

  await writeFile(configPath, stringify({
    version: 1,
    prepare: { mode: 'eager' },
    tasks: {
      dev: { run: [process.execPath, 'dev.cjs'] },
      'mark-workspace': { run: [process.execPath, 'mark.cjs', 'workspace.marker'] },
      'mark-repo': { run: [process.execPath, 'mark.cjs', 'repo.marker'] },
      'mark-discovered': { run: [process.execPath, 'mark.cjs', 'discovered.marker'] },
      'mark-ready': { run: [process.execPath, 'mark.cjs', 'ready.marker'] },
      'mark-started': { run: [process.execPath, 'mark.cjs', 'started.marker'] },
      'mark-stopped': { run: [process.execPath, 'mark.cjs', 'stopped.marker'] },
      'mark-removed': { run: [process.execPath, 'mark.cjs', 'removed.marker'] },
    },
    events: {
      'workspace.discovered': { tasks: ['mark-workspace'] },
      'repo.discovered': { tasks: ['mark-repo'] },
      'worktree.discovered': { tasks: ['mark-discovered'] },
      'worktree.ready': { tasks: ['mark-ready'] },
      'runtime.started': { tasks: ['mark-started'] },
      'runtime.stopped': { tasks: ['mark-stopped'] },
      'worktree.removed': { tasks: ['mark-removed'] },
    },
  }));

  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'daemon'),
    logRoot: join(fixture.userDataDir, 'logs'),
    socketPath: process.platform === 'win32'
      ? String.raw`\\.\pipe\wtm-lifecycle-events-${basename(controls)}`
      : join(controls, 'daemon.sock'),
    globalConfigPath: join(controls, 'global.toml'),
    runtimeInvocation: developmentRuntimeInvocation(),
    gracePeriodMs: 200,
    pollIntervalMs: 25,
  });
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'lifecycle-events', root: fixture.root, scope: 'local', configPath,
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir,
    mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  await runtime.start();
  client = new DaemonClient({ socketPath: runtime.paths.socketPath });
  await client.start();

  // --- "workspace.discovered" / "repo.discovered" / "worktree.discovered" / "worktree.ready":
  // the very first reconcile of this workspace and this repository, discovering both worktrees
  // for the first time (not `.created` -- that only fires on a *later* reconcile) and, since
  // `[prepare] mode = "eager"`, preparing and announcing `worktree.ready` for each of them too. It
  // also sets `lastReconciledAt`, so the *second* reconcile below (once the linked worktree is
  // gone) is the one that can report it `orphaned`. ---
  const seeded = await client.request('reconcile');
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const beforeRemoval = runtime.stateStore.listWorktrees(repository.id);
  assert.equal(beforeRemoval.length, 2, JSON.stringify(beforeRemoval));
  worktreeId = beforeRemoval.find((record) => record.isMain)!.id;
  await waitFor(() => existsSync(markerPath('workspace.marker')), 'workspace.discovered marker');
  await waitFor(() => existsSync(markerPath('repo.marker')), 'repo.discovered marker');
  await waitFor(() => existsSync(markerPath('discovered.marker')), 'worktree.discovered marker');
  await waitFor(() => existsSync(markerPath('ready.marker')), 'worktree.ready marker');

  // --- "runtime.started": the daemon dispatches it when a real supervised task really starts ---
  const started = await invoke(['start', 'dev']);
  assert.equal(started.code, 0, JSON.stringify(started));
  assert.equal(started.envelope.ok, true, JSON.stringify(started));
  await waitFor(() => existsSync(markerPath('dev.pid')), 'dev task pid file');
  await waitFor(() => existsSync(markerPath('started.marker')), 'runtime.started marker');
  const devPid = Number(readFileSync(markerPath('dev.pid'), 'utf8'));
  assert.equal((await platform.inspectProcess(devPid)).status, 'present');

  // --- "runtime.stopped": the daemon dispatches it when that same task really stops ---
  const stopped = await invoke(['stop', 'dev']);
  assert.equal(stopped.code, 0, JSON.stringify(stopped));
  assert.equal(stopped.envelope.ok, true, JSON.stringify(stopped));
  await waitFor(() => existsSync(markerPath('stopped.marker')), 'runtime.stopped marker');
  await waitFor(
    async () => (await platform.inspectProcess(devPid)).status === 'absent',
    'dev process actually exited',
  );
  assert.equal((await platform.inspectProcess(devPid)).status, 'absent');

  // --- "worktree.removed": raw Git removal (not `wtm remove`), then the daemon's own reconcile
  // notices the orphan and dispatches the event in the *main* worktree, as documented. ---
  git(fixture.firstRepoPath, 'worktree', 'remove', '--force', fixture.linkedWorktreePath);
  const afterRemoval = await client.request('reconcile');
  assert.equal(afterRemoval.ok, true, JSON.stringify(afterRemoval));
  await waitFor(() => existsSync(markerPath('removed.marker')), 'worktree.removed marker');
  const remaining = runtime.stateStore.listWorktrees(repository.id)
    .filter((record) => record.state !== 'ORPHANED' && record.state !== 'REMOVED');
  assert.equal(remaining.length, 1, JSON.stringify(remaining));
  assert.equal(remaining[0]?.isMain, true, JSON.stringify(remaining));

  console.log(JSON.stringify({
    workspaceDiscovered: true,
    repoDiscovered: true,
    worktreeDiscovered: true,
    worktreeReady: true,
    runtimeStarted: true,
    runtimeStopped: true,
    worktreeRemoved: true,
  }));
} finally {
  if (runtime !== null && worktreeId !== null) {
    try { await runtime.supervisor.stopAll(worktreeId); } catch { /* best effort */ }
  }
  try { await client?.close(); } finally { await runtime?.close(); }
  await rm(controls, { recursive: true, force: true });
  await fixture.cleanup();
}
