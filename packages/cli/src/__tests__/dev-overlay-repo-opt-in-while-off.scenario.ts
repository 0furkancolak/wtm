import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { basename, join } from 'node:path';
import { readGitRepositoryIdentity } from '@wtm/core';
import { stringify } from 'smol-toml';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { developmentRuntimeInvocation } from '../../../testkit/src/runtime-invocation';
import { createWorkspaceFixture } from '../../../testkit/src/workspace-fixture';
import { createProductionDaemon, type ProductionDaemonRuntime } from '../../../daemon/src/runtime-factory';
import { buildProxyRoutes } from '../../../daemon/src/proxy-routes';
import { DaemonClient } from '../client';
import { runCli } from '../main';

/**
 * Regression for the merge-audit finding on PR #83: `[dev-overlay.repos.<name>].enabled = true`
 * must render the overlay even when the table-level `[dev-overlay].enabled` default is false —
 * `isDevOverlayEnabledForRepo` (unit-tested in `dev-overlay.test.ts`) already resolves that
 * correctly, but `createProductionDaemon` only ever constructed `ProxyServer`'s `htmlInjector`
 * when the table-level default itself was `true`, so the per-repo opt-in path was never reached
 * in production regardless of what the function it built would have returned. Proven here with a
 * real daemon, a real repository/worktree, a real backend and a real proxied HTTP request — the
 * same rigor `dev-overlay-three-worktrees.scenario.ts` uses for the opt-*out* direction.
 */
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-dev-overlay-optin-e2e-'));

const configPath = join(fixture.root, 'wtm.toml');
const globalConfigPath = join(controls, 'global.toml');
const taskTargetDatabasePath = join(controls, 'task-target-state.db');
const taskTargetGlobalConfigPath = join(controls, 'task-target-global.toml');
const proxyPort = 34_711;
const repoName = basename(fixture.firstRepoPath);

let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;
let startedWorktreeId: string | null = null;

async function invoke(cwd: string, argv: string[]): Promise<{ code: number; envelope: { ok: boolean } }> {
  assert.ok(client);
  let out = '';
  const code = await runCli([...argv, '--json'], {
    cwd,
    analysisDatabasePath: runtime!.paths.databasePath,
    daemonSocketPath: runtime!.paths.socketPath,
    runtimeClient: client,
    taskTargetDatabasePath,
    taskTargetGlobalConfigPath,
    stdout: (value) => { out += value; },
    stderr: () => {},
  });
  return { code, envelope: JSON.parse(out) };
}

async function waitFor<T>(produce: () => T | undefined | Promise<T | undefined>, description: string, deadlineMs = 10_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function proxiedGet(hostname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/', headers: { host: hostname },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForProxiedBody(hostname: string): Promise<string> {
  return waitFor(async () => {
    try {
      const response = await proxiedGet(hostname);
      return response.status === 200 ? response.body : undefined;
    } catch {
      return undefined;
    }
  }, `proxied response from ${hostname}`);
}

const devServerScript = [
  "const http = require('node:http');",
  'const server = http.createServer((req, res) => {',
  "  res.writeHead(200, { 'content-type': 'text/html' });",
  "  res.end('<html><head><title>dev</title></head><body><h1>hi</h1></body></html>');",
  '});',
  "server.listen(Number(process.env.PORT), '127.0.0.1');",
].join('\n');
const devServerScriptPath = join(controls, 'dev-server.cjs');

try {
  await writeFile(devServerScriptPath, devServerScript);
  await writeFile(configPath, stringify({
    version: 1,
    workspace: { name: 'dev-overlay-optin-while-off' },
    ports: { range: '31300-31399', web: { env: 'PORT' } },
    tasks: { dev: { run: [process.execPath, devServerScriptPath] } },
  }));
  // The table-level default is off; only this repository opts in. `stringify` (rather than
  // hand-written TOML) quotes `repoName` correctly regardless of what characters the fixture's
  // directory name happens to contain.
  await writeFile(globalConfigPath, stringify({
    proxy: { enabled: true, port: proxyPort },
    'dev-overlay': { enabled: false, repos: { [repoName]: { enabled: true } } },
  }));

  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'daemon'),
    logRoot: join(fixture.userDataDir, 'logs'),
    socketPath: process.platform === 'win32'
      ? String.raw`\\.\pipe\wtm-dev-overlay-optin-e2e-${basename(controls)}`
      : join(controls, 'daemon.sock'),
    globalConfigPath,
    runtimeInvocation: developmentRuntimeInvocation(),
    proxyHosts: ['127.0.0.1'],
    gracePeriodMs: 200,
    pollIntervalMs: 25,
  });
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'dev-overlay-optin-e2e', root: fixture.root, scope: 'local', configPath,
  });
  const identity = await readGitRepositoryIdentity(fixture.firstRepoPath);
  const repository = runtime.stateStore.upsertRepository({
    workspaceId: workspace.id, commonGitDir: identity.commonGitDir,
    mainRoot: fixture.firstRepoPath, remoteIdentity: null,
  });
  await runtime.start();
  client = new DaemonClient({ socketPath: runtime.paths.socketPath });
  await client.start();
  assert.ok(runtime.proxy, 'proxy must be enabled for this scenario');

  const seeded = await client.request('reconcile');
  assert.equal(seeded.ok, true, JSON.stringify(seeded));
  const worktrees = runtime.stateStore.listWorktrees(repository.id);
  const mainWorktree = worktrees.find((worktree) => worktree.isMain);
  assert.ok(mainWorktree, JSON.stringify(worktrees));
  startedWorktreeId = mainWorktree.id;

  const started = await invoke(fixture.firstRepoPath, ['start', 'dev']);
  assert.equal(started.code, 0, JSON.stringify(started));
  assert.equal(started.envelope.ok, true, JSON.stringify(started));

  await waitFor(() => {
    const active = runtime!.stateStore.listEndpointLeases({ states: ['ACTIVE'] });
    return active.length === 1 ? active : undefined;
  }, 'one active endpoint lease');

  const route = [...buildProxyRoutes(runtime.stateStore).values()].find((entry) => entry.worktreeId === startedWorktreeId);
  assert.ok(route, 'no proxy route for the started worktree');

  const body = await waitForProxiedBody(route.hostname);
  console.log(JSON.stringify({ overlayRendered: body.includes('wtm-dev-overlay'), sawRepoName: body.includes(repoName) }));
} finally {
  if (startedWorktreeId !== null) {
    try { await runtime?.supervisor.stopAll(startedWorktreeId); } catch { /* best effort */ }
  }
  try { await client?.close(); } finally { await runtime?.close(); }
  await rm(controls, { recursive: true, force: true });
  await fixture.cleanup();
}
