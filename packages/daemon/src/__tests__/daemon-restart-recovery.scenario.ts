import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { listGitWorktrees, readGitRepositoryIdentity } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { fixtureIpcAddress } from '../../../testkit/src/ipc-address';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../runtime-factory';

/**
 * Proves "daemon restart" against a *real* durable state database, not the `MemoryProcessStore`
 * test double the unit-level recovery tests in `process-supervisor.test.ts` use. Two full
 * `createProductionDaemon` lifetimes share the same `databasePath` (a real `SQLiteStateStore`,
 * `createProductionDaemon`'s own default), which is what makes the second `supervisor` instance's
 * recovery a genuine "daemon restart" rather than the same process continuing: no in-memory
 * carryover crosses `runtimeOne.close()` -> `runtimeTwo = await createProductionDaemon(options)`,
 * exactly docs/05-daemon-and-macos-runtime.md's "No previous in-memory state is required for
 * recovery." (A `worktree_id` column in `managed_process_start_reservations` has a real foreign
 * key onto `worktrees(id)` -- migration `003-managed-process-reservations.sql` -- so an arbitrary
 * worktree id, the shortcut `process-supervisor.test.ts`'s `MemoryProcessStore` double allows,
 * cannot even insert here; a real Git worktree has to be reconciled into the store first, which
 * is itself part of what makes this a faithful production-shaped test.)
 *
 * Two real spawned tasks exercise both outcomes docs/07-process-port-runtime.md's recovery step
 * documents: a still-live, identity-matching process is verified and kept `RUNNING` (never
 * adopted as a new record, never re-spawned); a process that actually exited while no daemon was
 * running at all is recovered as `STOPPED`.
 */
const platform = selectPlatformRuntime().process;
const fixture = await createWorkspaceFixture();
// The socket lives under its own short root, not the (longer) fixture `userDataDir`: a Unix
// socket path is bound by a small, fixed byte limit (`socket-path.ts`), and every other real
// daemon scenario in this suite (`readiness-workflow.scenario.ts`,
// `heavy-job-native-lifecycle.scenario.ts`) keeps the socket off the fixture root for the same
// reason.
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-restart-'));
const options = {
  dataRoot: join(fixture.userDataDir, 'restart-recovery'),
  databasePath: join(fixture.userDataDir, 'restart-recovery', 'state.db'),
  socketPath: fixtureIpcAddress(controls),
  logRoot: join(fixture.userDataDir, 'logs'),
  runtimeInvocation: developmentRuntimeInvocation(),
  gracePeriodMs: 500,
  pollIntervalMs: 25,
};
// Node itself, spawned by name via PATH rather than `process.execPath` (which resolves to the
// `bun` binary under `bun test`, not Node) -- the same long-running fixture argv used throughout
// `process-supervisor.test.ts`.
const longRunningArgv = ['node', '-e', 'setInterval(() => {}, 1 << 30);'];

let runtimeOne: ProductionDaemonRuntime | null = null;
let runtimeTwo: ProductionDaemonRuntime | null = null;
// Hoisted out of the `try` block so `finally` can still find and kill both real, infinitely-
// running task groups if an assertion throws partway through -- exactly the failure mode this
// scenario exists to catch, so leaking the process it was watching would be the worst possible
// way for it to fail.
let worktreeId: string | null = null;
let alivePgid: number | null = null;
let gonePgid: number | null = null;
try {
  runtimeOne = await createProductionDaemon(options);
  const workspace = runtimeOne.stateStore.upsertWorkspace({
    name: 'restart-recovery', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtimeOne.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir, mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  runtimeOne.stateStore.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.firstRepoPath));
  worktreeId = runtimeOne.stateStore.listWorktrees(repository.id).find((record) => record.isMain)!.id;
  await runtimeOne.start();

  const alive = await runtimeOne.supervisor.start({
    worktreeId, taskName: 'alive', argv: longRunningArgv, cwd: fixture.firstRepoPath, env: process.env,
  });
  alivePgid = alive.record.pgid;
  const gone = await runtimeOne.supervisor.start({
    worktreeId, taskName: 'gone', argv: longRunningArgv, cwd: fixture.firstRepoPath, env: process.env,
  });
  gonePgid = gone.record.pgid;
  assert.equal(alive.record.state, 'RUNNING');
  assert.equal(gone.record.state, 'RUNNING');

  // Closing this daemon generation's control handles must leave both real detached processes
  // running -- exactly what a killed/restarted wtmd leaves for the next generation to find.
  await runtimeOne.close();
  runtimeOne = null;
  const aliveAfterClose = await platform.inspectProcess(alive.record.pid);
  assert.equal(aliveAfterClose.status, 'present', 'closing the daemon must never touch a detached task');

  // Only now, with no daemon running at all, does "gone" actually exit -- a task that crashed or
  // was killed by something else while wtmd itself was down, not a supervised stop.
  platform.signalProcessGroup(gone.record.pgid, 'SIGKILL');
  await waitForGroupAbsent(gone.record.pgid);

  // A brand-new daemon generation: a brand-new SQLiteStateStore and a brand-new
  // ManagedProcessSupervisor instance, opened against the exact same durable database file
  // runtimeOne wrote. `runtime.start()` runs the real startup recovery hook internally
  // (`verifyProcessIdentities` -> `supervisor.recover()`), the same path a restarted `wtmd` runs.
  runtimeTwo = await createProductionDaemon(options);
  await runtimeTwo.start();

  const recoveredAlive = runtimeTwo.stateStore.getManagedProcess(alive.record.id);
  const recoveredGone = runtimeTwo.stateStore.getManagedProcess(gone.record.id);
  assert.ok(recoveredAlive, 'the alive record must survive the restart in the durable store');
  assert.ok(recoveredGone, 'the gone record must survive the restart in the durable store');
  assert.equal(recoveredAlive.state, 'RUNNING', 'a verified live identity is kept RUNNING, never adopted as a new record');
  assert.equal(recoveredAlive.pid, alive.record.pid);
  assert.equal(recoveredAlive.pgid, alive.record.pgid);
  assert.equal(recoveredAlive.processStartTime, alive.record.processStartTime);
  assert.equal(recoveredGone.state, 'STOPPED', 'a process gone while the daemon was down is recovered as STOPPED, not left dangling');

  // The recovered row is not merely a database read: the *same new* supervisor instance can still
  // stop the real OS process by the identity it just verified.
  const stopped = await runtimeTwo.supervisor.stop({ worktreeId, taskName: 'alive' });
  assert.equal(stopped.state, 'STOPPED');
  await waitForGroupAbsent(alive.record.pgid);
  assert.deepEqual(await platform.inspectProcess(alive.record.pid), { status: 'absent' });

  console.log(JSON.stringify({
    recoveredAliveState: recoveredAlive.state,
    recoveredAlivePidMatches: recoveredAlive.pid === alive.record.pid,
    recoveredGoneState: recoveredGone.state,
    stoppedAfterRestart: stopped.state,
  }));
} finally {
  // Unconditional cleanup. The happy path only terminates "alive" and "gone" through the
  // explicit `stop`/`SIGKILL` calls above; an assertion failure anywhere between starting them
  // and that final `stop` must not leak either real, infinitely-running child process onto the
  // host or CI runner. Every step below is its own try/catch, on purpose: one failing must never
  // skip the rest.
  const activeRuntime = runtimeTwo ?? runtimeOne;
  if (activeRuntime !== null && worktreeId !== null) {
    // The supervisor's own cleanup first: a real stop sequence (TERM, grace period, KILL) against
    // whichever runtime generation is still open, exactly like
    // `readiness-workflow.scenario.ts`'s finally block.
    try { await activeRuntime.supervisor.stopAll(worktreeId); } catch { /* fall through to the raw signal below */ }
  }
  // Belt-and-braces fallback straight through the platform seam, in case `stopAll` above could
  // not run at all (no runtime open, e.g. a failure before `runtimeTwo` existed) or did not know
  // about a record. Tolerates a group that is already gone.
  if (alivePgid !== null) {
    try { platform.signalProcessGroup(alivePgid, 'SIGKILL'); } catch { /* already gone, or never existed */ }
  }
  if (gonePgid !== null) {
    try { platform.signalProcessGroup(gonePgid, 'SIGKILL'); } catch { /* already gone, or never existed */ }
  }
  try { await runtimeOne?.close(); } catch { /* best-effort */ }
  try { await runtimeTwo?.close(); } catch { /* best-effort */ }
  try { await rm(controls, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { await fixture.cleanup(); } catch { /* best-effort */ }
}

async function waitForGroupAbsent(pgid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await platform.inspectProcessGroup(pgid)).status === 'absent') return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`process group ${String(pgid)} did not become absent within ${String(timeoutMs)}ms`);
}
