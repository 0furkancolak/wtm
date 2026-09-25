import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import { runProductionGcCommand } from '../resource-production';

/**
 * marcapony, 2026-09-25: a worktree that only ever ran `api:dev` held all 17 `[ports.*]` leases
 * for eight days, because every `wtm status` in every worktree leased the whole feature. Those
 * reports no longer lease, but what they already took stays until something gives it back.
 */
const fileTrust = selectPlatformRuntime().fileTrust;
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-gc-leases-')));
const workspaceRoot = join(root, 'workspace');
const databasePath = join(root, 'state.db');
let store: SQLiteStateStore | null = null;
let occupied: Server | null = null;

function gitWorktree(path: string, branch: string) {
  return {
    path, head: '0123456789abcdef', branch: `refs/heads/${branch}`,
    detached: false, bare: false, lockedReason: null, prunableReason: null,
  };
}

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return server;
}

async function freePort(): Promise<number> {
  const server = await listen(0);
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return address.port;
}

try {
  await mkdir(workspaceRoot, { recursive: true });
  store = new SQLiteStateStore(databasePath);
  const workspace = store.upsertWorkspace({ name: 'local', root: workspaceRoot, scope: 'local', configPath: null });
  const repository = (name: string) => store!.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(workspaceRoot, name, '.git'),
    mainRoot: join(workspaceRoot, name),
    remoteIdentity: null,
  });
  const api = repository('api');
  const web = repository('web');
  const apiTrees = store.reconcileWorktrees(api.id, [
    gitWorktree(join(workspaceRoot, 'api'), 'main'),
    gitWorktree(join(workspaceRoot, 'api', '.worktrees', 'never'), 'never-started'),
    gitWorktree(join(workspaceRoot, 'api', '.worktrees', 'ran'), 'ran-once'),
    gitWorktree(join(workspaceRoot, 'api', '.worktrees', 'busy'), 'port-in-use'),
  ]).discovered;
  const webTrees = store.reconcileWorktrees(web.id, [
    gitWorktree(join(workspaceRoot, 'web'), 'main'),
    gitWorktree(join(workspaceRoot, 'web', '.worktrees', 'ran'), 'ran-once'),
  ]).discovered;
  const tree = (trees: typeof apiTrees, branch: string) => {
    const found = trees.find((candidate) => candidate.branch === `refs/heads/${branch}`);
    if (found === undefined) throw new Error(`Expected a ${branch} worktree`);
    return found;
  };

  const lease = (worktreeId: string, name: string, port: number) => store!.allocateEndpoint({
    worktreeId, name, protocol: 'tcp', host: '127.0.0.1',
    portRange: { min: port, max: port }, preferredPort: port,
  }, () => true);
  const ports = await Promise.all(Array.from({ length: 5 }, async () => await freePort()));
  const never = tree(apiTrees, 'never-started');
  lease(never.id, 'web', ports[0]!);
  lease(never.id, 'api', ports[1]!);
  // A feature is a branch across repositories; the leases sit on one of them, and a run in
  // the *other* one is what makes them the feature's working ports.
  lease(tree(apiTrees, 'ran-once').id, 'web', ports[2]!);
  const ranWeb = tree(webTrees, 'ran-once');
  store.reserveManagedProcessStart(ranWeb.id, 'dev', 'token', '2026-09-20T08:00:00.000Z', { expiresAt: '2026-09-20T08:05:00.000Z' });
  store.createManagedProcess({
    worktreeId: ranWeb.id, taskName: 'dev', pid: 4242, pgid: 4242, processStartTime: 'start',
    commandFingerprint: 'fingerprint', state: 'STARTING', startedAt: '2026-09-20T08:00:01.000Z', stoppedAt: null,
    stdoutPath: '/logs/dev.stdout.log', stderrPath: '/logs/dev.stderr.log',
  }, { reservationToken: 'token' });
  const busy = tree(apiTrees, 'port-in-use');
  lease(busy.id, 'web', ports[3]!);
  lease(busy.id, 'api', ports[4]!);
  // Something listens on a leased port that no managed task accounts for: a foreground
  // `wtm run`, or a server started from `eval "$(wtm env)"`. Its ports stay.
  occupied = await listen(ports[4]!);
  store.close();
  store = null;

  const active = () => {
    const reader = new SQLiteStateStore(databasePath, { readonly: true });
    try {
      return reader.listEndpointLeases({ states: ['ACTIVE'] }).map(({ port }) => port).sort((a, b) => a - b);
    } finally { reader.close(); }
  };

  const planned = await runProductionGcCommand({ databasePath, cwd: workspaceRoot, apply: false, fileTrust });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const plannedGroups = planned.data?.leases ?? [];
  assert.deepEqual(plannedGroups.map(({ branch, outcome }) => [branch, outcome]), [
    ['never-started', 'reclaimable'],
    ['port-in-use', 'in-use'],
  ]);
  assert.deepEqual(plannedGroups[0]?.endpoints, [{ name: 'api', port: ports[1] }, { name: 'web', port: ports[0] }]);
  assert.deepEqual(active(), [...ports].sort((a, b) => a - b), 'a dry run releases nothing');

  const applied = await runProductionGcCommand({ databasePath, cwd: workspaceRoot, apply: true, fileTrust });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(applied.data?.leases?.map(({ branch, outcome }) => [branch, outcome]), [
    ['never-started', 'released'],
    ['port-in-use', 'in-use'],
  ]);
  assert.deepEqual(active(), [ports[2]!, ports[3]!, ports[4]!].sort((a, b) => a - b));

  const again = await runProductionGcCommand({ databasePath, cwd: workspaceRoot, apply: true, fileTrust });
  assert.deepEqual(again.data?.leases?.map(({ branch }) => branch), ['port-in-use']);
  console.log(JSON.stringify({ ok: true }));
} finally {
  store?.close();
  await new Promise<void>((resolve) => { if (occupied === null) resolve(); else occupied.close(() => resolve()); });
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}
