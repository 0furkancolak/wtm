import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readGitRepositoryIdentity } from '@wtm/core';
import { stringify } from 'smol-toml';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../../../daemon/src/runtime-factory';
import { DaemonClient } from '../client';
import { runCli } from '../main';

/**
 * `wtm create` against a *real, running* production daemon (not a stub `runtimeClient`), which is
 * the only way to observe what `create.ts` documents but nothing before this scenario exercised
 * end to end: a daemon that answers `reconcile` has already dispatched `worktree.created` — so its
 * attached tasks actually ran — and already applied `[prepare] mode` for the worktree just
 * created. Three creations share one daemon, each under its own rewritten `wtm.toml`:
 *
 * - `feat/hook`   — a task attached to `worktree.created`, proving the hook itself runs;
 * - `feat/eager`  — `[prepare] mode = "eager"` with a declared resource, proving it materializes
 *                   immediately, with no task run in between;
 * - `feat/lazy`   — the same resource under the default `lazy` mode, proving it does *not*.
 */
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-create-daemon-'));
const configPath = join(fixture.root, 'wtm.toml');
const taskTargetDatabasePath = join(controls, 'task-target-state.db');
const taskTargetGlobalConfigPath = join(controls, 'task-target-global.toml');

let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: { ok: boolean; data: any; warnings: Array<{ code: string }>; errors: Array<{ code: string }> };
}

async function create(branch: string): Promise<Invocation> {
  assert.ok(client);
  let out = '';
  let err = '';
  const code = await runCli(['create', branch, '--json'], {
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

/** Polls for a filesystem side effect a spawned task produces asynchronously off the daemon. */
async function waitFor(predicate: () => boolean, description: string, deadlineMs = 8_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

try {
  // A tracked file, so every worktree `wtm create` checks out at HEAD already has it.
  await writeFile(join(fixture.firstRepoPath, 'mark.cjs'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.writeFileSync(path.join(process.cwd(), 'created.marker'), 'x');",
    '',
  ].join('\n'));
  git(fixture.firstRepoPath, 'add', 'mark.cjs');
  git(fixture.firstRepoPath, 'commit', '-m', 'Add worktree.created marker task');

  // The hook configuration is in place before the daemon ever starts, so its first reconcile
  // (which only discovers the main worktree, not `worktree.created`) never has to read a
  // missing file.
  await writeFile(configPath, stringify({
    version: 1,
    tasks: { mark: { run: [process.execPath, 'mark.cjs'] } },
    events: { 'worktree.created': { tasks: ['mark'] } },
  }));

  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'daemon'),
    logRoot: join(fixture.userDataDir, 'logs'),
    socketPath: process.platform === 'win32'
      ? String.raw`\\.\pipe\wtm-create-daemon-${basename(controls)}`
      : join(controls, 'daemon.sock'),
    globalConfigPath: join(controls, 'global.toml'),
    runtimeInvocation: developmentRuntimeInvocation(),
    gracePeriodMs: 200,
    pollIntervalMs: 25,
  });
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'create-daemon', root: fixture.root, scope: 'local', configPath,
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  runtime.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir,
    mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  await runtime.start();
  client = new DaemonClient({ socketPath: runtime.paths.socketPath });
  await client.start();

  // First reconcile: discovers the main worktree only (`worktree.discovered`, not `.created`),
  // so the repository's `lastReconciledAt` is set before any `create` runs its own reconcile.
  const seeded = await client.request('reconcile');
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  // --- "daemon running": the daemon dispatches `worktree.created` and its task actually runs ---
  const hookRun = await create('feat/hook');
  assert.equal(hookRun.code, 0, JSON.stringify(hookRun));
  assert.equal(hookRun.envelope.data?.registration, 'daemon', JSON.stringify(hookRun));
  assert.deepEqual(hookRun.envelope.warnings, []);
  const hookPath: string = hookRun.envelope.data.worktree.path;
  const markerPath = join(hookPath, 'created.marker');
  await waitFor(() => existsSync(markerPath), `worktree.created task marker at ${markerPath}`);

  // --- "eager prepare": `[prepare] mode = "eager"` materializes the resource immediately ---
  await writeFile(configPath, stringify({
    version: 1,
    prepare: { mode: 'eager' },
    resources: { data: { path: 'data', policy: 'ephemeral' } },
  }));
  const eagerRun = await create('feat/eager');
  assert.equal(eagerRun.code, 0, JSON.stringify(eagerRun));
  assert.equal(eagerRun.envelope.data?.registration, 'daemon', JSON.stringify(eagerRun));
  assert.deepEqual(eagerRun.envelope.warnings, []);
  const eagerPath: string = eagerRun.envelope.data.worktree.path;
  // The daemon flushes its reconcile queue — which is what `create` awaits — before answering,
  // so eager preparation is synchronous from this scenario's point of view: no poll needed, and
  // none would distinguish "materialized late" from "never materialized" anyway.
  const eagerPrepared = existsSync(join(eagerPath, 'data'));

  // --- "lazy prepare": the default mode leaves the same resource alone at creation time ---
  await writeFile(configPath, stringify({
    version: 1,
    resources: { data: { path: 'data', policy: 'ephemeral' } },
  }));
  const lazyRun = await create('feat/lazy');
  assert.equal(lazyRun.code, 0, JSON.stringify(lazyRun));
  assert.equal(lazyRun.envelope.data?.registration, 'daemon', JSON.stringify(lazyRun));
  assert.deepEqual(lazyRun.envelope.warnings, []);
  const lazyPath: string = lazyRun.envelope.data.worktree.path;
  // A grace window a real eager materialization would never need (it is awaited inside the
  // `reconcile` response above): if lazy ever started preparing resources it did not promise,
  // this gives that bug time to show up rather than racing it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const lazyPrepared = existsSync(join(lazyPath, 'data'));

  console.log(JSON.stringify({
    hookRan: true,
    eagerPrepared,
    lazyPrepared,
  }));
} finally {
  try { await client?.close(); } finally { await runtime?.close(); }
  await rm(controls, { recursive: true, force: true });
  await fixture.cleanup();
}
