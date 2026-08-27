import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SQLiteStateStore } from '../../state/sqlite-store';
import { allocateStableEndpoint } from '../endpoints';

const execFileAsync = promisify(execFile);
const scenarioPath = fileURLToPath(import.meta.url);
const scenario = process.argv[2];

if (scenario === 'worker') {
  const databasePath = process.argv[3];
  const worktreeId = process.argv[4];
  if (databasePath === undefined || worktreeId === undefined) throw new Error('Expected database path and worktree ID');
  const store = new SQLiteStateStore(databasePath);
  try {
    const lease = allocateStableEndpoint(store, endpointRequest(worktreeId));
    process.stdout.write(JSON.stringify({ id: lease.id, port: lease.port }));
  } finally {
    store.close();
  }
} else if (scenario === 'os-bind-probe') {
  process.stdout.write(JSON.stringify(await osBindProbe()));
} else if (scenario === 'concurrent') {
  process.stdout.write(JSON.stringify(await concurrentAllocation()));
} else {
  throw new Error(`Unknown scenario: ${scenario ?? '<missing>'}`);
}

async function osBindProbe() {
  const { server, port } = await listenWithFreeSuccessor();
  const store = new SQLiteStateStore(':memory:');
  try {
    const worktreeId = createWorktrees(store, 1)[0];
    if (worktreeId === undefined) throw new Error('Expected a worktree fixture');
    const request = {
      ...endpointRequest(worktreeId),
      portRange: { min: port, max: port + 1 },
      preferredPort: port,
    };
    const first = allocateStableEndpoint(store, request);
    const repeated = allocateStableEndpoint(store, request);
    return {
      skippedBusyPort: first.port === port + 1,
      repeatedLeaseWasStable: repeated.id === first.id && repeated.port === first.port,
    };
  } finally {
    store.close();
    await closeServer(server);
  }
}

async function concurrentAllocation() {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-endpoints-'));
  const databasePath = join(directory, 'state.db');
  try {
    const store = new SQLiteStateStore(databasePath);
    const worktreeIds = createWorktrees(store, 6);
    store.close();
    const results = await Promise.all(worktreeIds.map(async (worktreeId) => {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', scenarioPath, 'worker', databasePath, worktreeId],
        { encoding: 'utf8' },
      );
      if (stderr !== '') throw new Error(stderr);
      return JSON.parse(stdout) as { id: string; port: number };
    }));

    const reopened = new SQLiteStateStore(databasePath);
    const repeatedPorts = worktreeIds.map((worktreeId) =>
      allocateStableEndpoint(reopened, endpointRequest(worktreeId)).port,
    );
    reopened.close();
    return {
      allocatedCount: results.length,
      uniqueLeaseCount: new Set(results.map(({ id }) => id)).size,
      uniquePortCount: new Set(results.map(({ port }) => port)).size,
      repeatedPortsWereStable: repeatedPorts.every((port, index) => port === results[index]?.port),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function endpointRequest(worktreeId: string) {
  return {
    worktreeId,
    name: 'web',
    protocol: 'tcp' as const,
    host: '127.0.0.1',
    portRange: { min: 42000, max: 42020 },
  };
}

function createWorktrees(store: SQLiteStateStore, count: number): string[] {
  const workspace = store.upsertWorkspace({
    name: 'demo',
    root: '/projects/demo',
    scope: 'local',
    configPath: null,
  });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: '/projects/demo/repo/.git',
    mainRoot: '/projects/demo/repo',
    remoteIdentity: null,
  });
  return store.reconcileWorktrees(repository.id, Array.from({ length: count }, (_, index) => ({
    path: index === 0 ? '/projects/demo/repo' : `/projects/demo/repo-${index}`,
    head: `head-${index}`,
    branch: `refs/heads/branch-${index}`,
    detached: false,
    bare: false,
    lockedReason: null,
    prunableReason: null,
  }))).discovered.map(({ id }) => id);
}

async function listenWithFreeSuccessor(): Promise<{ server: Server; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await listen(server, 0);
    const address = server.address();
    if (address === null || typeof address === 'string' || address.port >= 65535) {
      await closeServer(server);
      continue;
    }
    const successor = createServer();
    try {
      await listen(successor, address.port + 1);
      await closeServer(successor);
      return { server, port: address.port };
    } catch {
      await closeServer(successor);
      await closeServer(server);
    }
  }
  throw new Error('Could not reserve a TCP port with a free successor');
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
}
