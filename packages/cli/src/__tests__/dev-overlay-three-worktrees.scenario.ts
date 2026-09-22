import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
 * Todo item 46's own kabul kriteri: "Üç feature'ın `web`'i aynı anda ayaktayken her sekme kendi
 * worktree'sini sayfadan söylüyor." Everything the dev overlay does with real state-store data
 * (`dev-overlay.test.ts`) and everything `ProxyServer` does with a fake `resolveRoute`
 * (`proxy-dev-overlay.test.ts`) was already unit-tested before this scenario — what neither of
 * those proves is the full path: a real daemon, a real reconcile discovering real worktrees, a
 * real endpoint allocation per worktree, three real `http.Server` backends actually listening,
 * and three real HTTP requests through the real `ProxyServer`, each one's injected fragment
 * naming the *correct* worktree rather than a neighbour's.
 *
 * One repository, three worktrees, three different branches (`main`, `feature/existing`,
 * `feature/third`) — a worktree's branch is git's own uniqueness boundary, so three worktrees on
 * three branches is the natural way to get three independent `[ports.web]` leases at once, the
 * same as three real feature branches checked out side by side. Each runs the identical `dev`
 * task (a tiny Node HTTP server reading `PORT` from its environment); nothing about the backend
 * itself distinguishes one worktree from another — the point of this scenario is that the
 * *overlay* tells them apart using only what the daemon's own state store already knows.
 */
const fixture = await createWorkspaceFixture();
const controls = await mkdtemp(join(shortTmpRoot(), 'wtm-dev-overlay-e2e-'));

const configPath = join(fixture.root, 'wtm.toml');
const globalConfigPath = join(controls, 'global.toml');
const taskTargetDatabasePath = join(controls, 'task-target-state.db');
const taskTargetGlobalConfigPath = join(controls, 'task-target-global.toml');
const thirdWorktreePath = join(fixture.root, 'linked third worktree');
const proxyPort = 34_611;

let runtime: ProductionDaemonRuntime | null = null;
let client: DaemonClient | null = null;
const startedWorktreeIds: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: { ok: boolean; data: any; warnings: Array<{ code: string }>; errors: Array<{ code: string }> };
}

async function invoke(cwd: string, argv: string[]): Promise<Invocation> {
  assert.ok(client);
  let out = '';
  let err = '';
  const code = await runCli([...argv, '--json'], {
    cwd,
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

async function waitFor<T>(
  produce: () => T | undefined | Promise<T | undefined>,
  description: string,
  deadlineMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A bare HTTP GET through the real proxy, addressed by `Host` header like a browser tab would. */
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

/** Polls a proxied GET until the backend has actually started accepting connections. */
async function waitForProxiedOverlay(hostname: string): Promise<string> {
  return waitFor(async () => {
    try {
      const response = await proxiedGet(hostname);
      return response.status === 200 && response.body.includes('wtm-dev-overlay') ? response.body : undefined;
    } catch {
      return undefined;
    }
  }, `overlay fragment from ${hostname}`);
}

// Written to a file rather than passed as an inline `-e` argument: every `run` argv element goes
// through `resolveTemplate` (`{workspace.root}`-style substitution), which treats any `{...}` as
// an unresolved template variable and fails the task — and a plain Node HTTP server is full of
// object-literal braces. A file's contents are never template-resolved, only argv is.
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
  git(fixture.firstRepoPath, 'worktree', 'add', '-b', 'feature/third', thirdWorktreePath);
  await writeFile(devServerScriptPath, devServerScript);

  await writeFile(configPath, stringify({
    version: 1,
    workspace: { name: 'three-worktree-dev-overlay' },
    ports: {
      range: '31200-31299',
      web: { env: 'PORT' },
    },
    tasks: {
      dev: { run: [process.execPath, devServerScriptPath] },
    },
  }));
  await writeFile(globalConfigPath, [
    '[proxy]', 'enabled = true', `port = ${proxyPort}`, '',
    '[dev-overlay]', 'enabled = true',
  ].join('\n'));

  runtime = await createProductionDaemon({
    dataRoot: join(fixture.userDataDir, 'daemon'),
    logRoot: join(fixture.userDataDir, 'logs'),
    socketPath: process.platform === 'win32'
      ? String.raw`\\.\pipe\wtm-dev-overlay-e2e-${basename(controls)}`
      : join(controls, 'daemon.sock'),
    globalConfigPath,
    runtimeInvocation: developmentRuntimeInvocation(),
    proxyHosts: ['127.0.0.1'],
    gracePeriodMs: 200,
    pollIntervalMs: 25,
  });
  const workspace = runtime.stateStore.upsertWorkspace({
    name: 'dev-overlay-e2e', root: fixture.root, scope: 'local', configPath,
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
  assert.equal(worktrees.length, 3, JSON.stringify(worktrees));

  const byBranch = new Map(worktrees.map((worktree) => [worktree.branch, worktree] as const));
  const expectations: Array<{ cwd: string; branchNeedle: string }> = [
    { cwd: fixture.firstRepoPath, branchNeedle: 'main' },
    { cwd: fixture.linkedWorktreePath, branchNeedle: 'feature/existing' },
    { cwd: thirdWorktreePath, branchNeedle: 'feature/third' },
  ];

  for (const { cwd } of expectations) {
    const started = await invoke(cwd, ['start', 'dev']);
    assert.equal(started.code, 0, JSON.stringify(started));
    assert.equal(started.envelope.ok, true, JSON.stringify(started));
  }
  for (const worktree of worktrees) startedWorktreeIds.push(worktree.id);

  await waitFor(() => {
    const active = runtime!.stateStore.listEndpointLeases({ states: ['ACTIVE'] });
    return active.length === 3 ? active : undefined;
  }, 'three active endpoint leases');

  const routesByWorktreeId = new Map(
    [...buildProxyRoutes(runtime.stateStore).values()].map((route) => [route.worktreeId, route] as const),
  );
  assert.equal(routesByWorktreeId.size, 3, JSON.stringify([...routesByWorktreeId.values()]));

  const results: Record<string, { ok: boolean; sawOwnBranch: boolean; leakedOtherBranch: boolean }> = {};
  for (const { branchNeedle } of expectations) {
    const worktree = [...byBranch.entries()].find(([branch]) => branch !== null && branch.includes(branchNeedle))?.[1];
    assert.ok(worktree, `no discovered worktree for branch containing ${branchNeedle}`);
    const route = routesByWorktreeId.get(worktree.id);
    assert.ok(route, `no proxy route for worktree ${worktree.id} (${branchNeedle})`);

    const body = await waitForProxiedOverlay(route.hostname);
    const others = expectations.map((entry) => entry.branchNeedle).filter((needle) => needle !== branchNeedle);
    results[branchNeedle] = {
      ok: body.includes('wtm-dev-overlay'),
      sawOwnBranch: body.includes(branchNeedle),
      leakedOtherBranch: others.some((needle) => body.includes(needle)),
    };
  }

  console.log(JSON.stringify(results));
} finally {
  for (const worktreeId of startedWorktreeIds) {
    try { await runtime?.supervisor.stopAll(worktreeId); } catch { /* best effort */ }
  }
  try { await client?.close(); } finally { await runtime?.close(); }
  await rm(controls, { recursive: true, force: true });
  await fixture.cleanup();
}
