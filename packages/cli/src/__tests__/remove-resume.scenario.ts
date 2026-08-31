/**
 * A `wtm remove` killed mid-cleanup, and what the next caller is allowed to do about it.
 *
 * The child is stopped where a real crash would leave the most dangerous state: inside
 * `stop-processes`, after the stage was journalled on the lease and before the worktree's
 * processes were confirmed gone. A daemon that accepts the `stop` and never answers is what
 * holds it there, so the kill lands at a known stage rather than wherever the scheduler put it.
 *
 * One thing is simulated rather than waited for: the lease's two-minute TTL is moved into the
 * past with a direct `UPDATE` after the child dies. Liveness alone is not enough — the store
 * deliberately refuses to reclaim an unexpired lease even from a dead holder — and two minutes
 * of wall clock is not a test.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The same driver the state store itself uses. A second driver on one WAL database leaves an
// already-open connection reading a stale snapshot, which cost an afternoon to find once.
import Database from 'better-sqlite3';
import {
  FrameDecoder,
  encodeFrame,
  ipcRequestSchema,
  protocolVersion,
  type IpcRequest,
  type IpcResponse,
} from '@wtm/protocol';
import { listGitWorktrees, SQLiteStateStore } from '@wtm/core';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';

interface ChildReport {
  exitCode: number;
  envelope: {
    ok: boolean;
    warnings: Array<{ code: string }>;
    errors: Array<{ code: string; context?: Record<string, unknown>; remediation?: Array<{ argv: string[] }> }>;
  };
  stderr: string;
}

const childPath = fileURLToPath(new URL('./remove-child.ts', import.meta.url));
const fixture = await createGitSafetyFixture();
const socketRoot = await mkdtemp(join(tmpdir(), 'wtm-resume-'));
const socketPath = join(socketRoot, 'd.sock');
const markerPath = join(socketRoot, 'stop-received');
let store: SQLiteStateStore | null = null;

try {
  const databasePath = join(fixture.root, 'state.db');
  const globalConfigPath = join(fixture.root, 'absent-global.toml');
  store = new SQLiteStateStore(databasePath);
  const workspace = store.upsertWorkspace({
    name: 'resume', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(fixture.repoPath, '.git'),
    mainRoot: fixture.repoPath,
    remoteIdentity: null,
  });
  store.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.repoPath));
  const worktree = store.listWorktrees(repository.id)
    .find(({ path }) => path === fixture.linkedWorktreePath);
  if (worktree === undefined) throw new Error('the fixture worktree was not registered');
  const managed = store.createManagedProcess({
    worktreeId: worktree.id,
    taskName: 'dev',
    pid: 999_999,
    pgid: 999_999,
    processStartTime: 'Mon Jan  1 00:00:00 2035',
    commandFingerprint: 'dev-server',
    state: 'RUNNING',
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stdoutPath: join(fixture.root, 'dev.out'),
    stderrPath: join(fixture.root, 'dev.err'),
  });

  let stopRequests = 0;
  const activeStore = store;
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const frame of decoder.push(buffer)) {
        const request = ipcRequestSchema.parse(JSON.parse(frame.toString('utf8')));
        if (request.command !== 'stop') {
          answer(socket, request, null);
          continue;
        }
        stopRequests += 1;
        if (stopRequests === 1) {
          // Accepted and never answered: the caller is now inside `stop-processes`.
          void writeFile(markerPath, '');
          continue;
        }
        // The stop a supervisor would really perform: the record changes state, and only then
        // is the caller told, so the gate that re-reads the database has something to find.
        activeStore.updateManagedProcess(managed.id, {
          expectedStates: ['RUNNING', 'STOPPING'],
          state: 'STOPPED',
          stoppedAt: new Date().toISOString(),
        });
        answer(socket, request, { processes: [{ id: managed.id }] });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const childArgs = [databasePath, globalConfigPath, fixture.repoPath, fixture.linkedWorktreePath, socketPath];
  const holder = spawn('node', ['--import', 'tsx', childPath, ...childArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  holder.stdout.resume();
  holder.stderr.resume();
  const holderClosed = new Promise<void>((resolve) => { holder.once('close', () => resolve()); });
  await waitFor(markerPath, 60_000);
  holder.kill('SIGKILL');
  await holderClosed;

  const abandoned = store.readRepositoryOperationLease({ repositoryId: repository.id, operation: 'remove' });
  // Sampled where they mean something: after the kill, and again after the plain re-run. Reading
  // them at the end would only ever describe the state the resumed run left behind.
  const abandonedWorktreeIntact = existsSync(fixture.linkedWorktreePath);
  expireLease(databasePath);

  // Awaited rather than `spawnSync`ed: a synchronous child would freeze this process's event
  // loop, and the daemon these children talk to is served from it.
  const refused = await runChild(childArgs);
  const refusedWorktreeIntact = existsSync(fixture.linkedWorktreePath);
  const resumed = await runChild([...childArgs, '--resume']);

  process.stdout.write(`${JSON.stringify({
    abandonedStage: abandoned?.stage ?? null,
    abandonedWorktreeIntact,
    refusedExitCode: refused.exitCode,
    refusedCodes: refused.envelope.errors.map(({ code }) => code),
    refusedAbandoned: refused.envelope.errors[0]?.context?.['abandoned'] ?? null,
    refusedStage: refused.envelope.errors[0]?.context?.['stage'] ?? null,
    refusedRemediation: refused.envelope.errors[0]?.remediation?.map(({ argv }) => argv) ?? null,
    refusedWorktreeIntact,
    resumedExitCode: resumed.exitCode,
    resumedOk: resumed.envelope.ok,
    resumedWorktreeGone: !existsSync(fixture.linkedWorktreePath),
    stopRequests,
    resumedProcessStates: store.listManagedProcesses({ worktreeId: worktree.id }).map(({ state }) => state),
    leaseAfterResume: store.readRepositoryOperationLease({ repositoryId: repository.id, operation: 'remove' }),
  })}\n`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
} finally {
  store?.close();
  await rm(socketRoot, { recursive: true, force: true });
  await fixture.cleanup();
}

function answer(socket: Socket, request: IpcRequest, data: unknown): void {
  const response: IpcResponse = {
    protocol: protocolVersion,
    id: request.id,
    envelope: { schemaVersion: 1, ok: true, command: request.command, data, warnings: [], errors: [] },
  };
  socket.write(encodeFrame(Buffer.from(JSON.stringify(response))));
}

/**
 * Moves the abandoned lease's expiry into the past. The store refuses to reclaim an unexpired
 * lease even when its owner is provably gone, which is the correct rule and the reason this has
 * to be simulated rather than observed.
 */
function expireLease(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec("UPDATE repository_operation_leases SET expires_at = '1970-01-01T00:00:00.000Z'");
  } finally {
    database.close();
  }
}

async function runChild(args: readonly string[]): Promise<ChildReport> {
  const child = spawn('node', ['--import', 'tsx', childPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return await new Promise<ChildReport>((settle, fail) => {
    child.once('error', fail);
    child.once('close', () => {
      try {
        settle({ ...(JSON.parse(stdout) as ChildReport), stderr });
      } catch {
        fail(new Error(`child produced no report: ${stderr || stdout}`));
      }
    });
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}
