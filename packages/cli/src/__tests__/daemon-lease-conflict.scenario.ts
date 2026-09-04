/**
 * A `wtm remove` in one process and the daemon's own lease-acquisition path in another, both
 * against one repository: the cross-process guarantee is only proven once the two holders are
 * composed the way their real entry points compose them, not just run twice from the same one.
 *
 * The CLI side is `remove-child.ts`, the same real `wtm remove` the CLI-vs-CLI scenario spawns.
 * The daemon side is `daemon-lease-conflict-child.ts`, which calls `withRepositoryOperationLease`
 * directly with `@wtm/platform`'s `selectPlatformRuntime` — the same composition
 * `packages/daemon/src/runtime-factory.ts` and `packages/daemon/src/process-supervisor.ts` use —
 * because there is no daemon subcommand yet that performs a destructive repository operation to
 * spawn instead. Both are real, separate OS processes reading and writing the same `state.db`,
 * which is what makes the PID-based liveness check in `operation-lease.ts` a fact about two
 * processes rather than an assumption about one.
 *
 * The schedule is made deterministic the same way the CLI-vs-CLI scenario does it: a `git` earlier
 * on the CLI child's PATH blocks its first `status` call — which happens inside the removal lease
 * — until this scenario releases it, so "the lease was held when the daemon-side attempt ran" is a
 * fact of the schedule rather than a hope about a race.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGitWorktrees, SQLiteStateStore } from '@wtm/core';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runScenario } from '../../../testkit/src/scenario-child';
import { writeExecutableFixture } from '../../../testkit/src/executable-fixture';
import { resolveRealExecutablePath } from '../../../testkit/src/real-executable';

interface ChildReport {
  exitCode: number;
  envelope: {
    ok: boolean;
    warnings: Array<{ code: string }>;
    errors: Array<{ code: string; context?: Record<string, unknown> }>;
  };
  stderr: string;
}

interface DaemonAttempt {
  outcome: 'acquired' | 'conflict';
  code?: string;
  abandoned?: boolean;
  context?: Record<string, unknown>;
}

const cliChildPath = fileURLToPath(new URL('./remove-child.ts', import.meta.url));
const daemonChildPath = fileURLToPath(new URL('./daemon-lease-conflict-child.ts', import.meta.url));
const fixture = await createGitSafetyFixture();
const shimRoot = await mkdtemp(join(tmpdir(), 'wtm-daemon-conflict-shim-'));
let store: SQLiteStateStore | null = null;

try {
  const databasePath = join(fixture.root, 'state.db');
  const globalConfigPath = join(fixture.root, 'absent-global.toml');
  store = new SQLiteStateStore(databasePath);
  const workspace = store.upsertWorkspace({
    name: 'conflict', root: fixture.root, scope: 'local', configPath: join(fixture.root, 'wtm.toml'),
  });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(fixture.repoPath, '.git'),
    mainRoot: fixture.repoPath,
    remoteIdentity: null,
  });
  store.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.repoPath));

  const markerPath = join(shimRoot, 'blocked');
  const releasePath = join(shimRoot, 'release');
  const shimDirectory = join(shimRoot, 'bin');
  await installBlockingGit(shimDirectory, markerPath, releasePath);

  const cli = spawnChild(
    [databasePath, globalConfigPath, fixture.repoPath, fixture.linkedWorktreePath, '-'],
    { PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}` },
  );
  await waitFor(markerPath, 30_000);

  const daemon = runChildSync([databasePath, repository.id, 'remove']);

  await writeFile(releasePath, '');
  const cliReport = await cli;

  process.stdout.write(`${JSON.stringify({
    cliExitCode: cliReport.exitCode,
    cliOk: cliReport.envelope.ok,
    cliWorktreeGone: !existsSync(fixture.linkedWorktreePath),
    daemonOutcome: daemon.outcome,
    daemonCode: daemon.code ?? null,
    daemonAbandoned: daemon.abandoned ?? null,
    daemonRepositoryId: daemon.context?.['repositoryId'] ?? null,
    daemonOperation: daemon.context?.['operation'] ?? null,
  })}\n`);
} finally {
  store?.close();
  await rm(shimRoot, { recursive: true, force: true });
  await fixture.cleanup();
}

function spawnChild(args: readonly string[], env: Record<string, string>): Promise<ChildReport> {
  const child = spawn('node', ['--import', 'tsx', cliChildPath, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return new Promise<ChildReport>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => {
      try {
        resolve(JSON.parse(stdout) as ChildReport);
      } catch {
        reject(new Error(`cli child produced no report: ${stderr || stdout}`));
      }
    });
  });
}

function runChildSync(args: readonly string[]): DaemonAttempt {
  const result = runScenario('node', ['--import', 'tsx', daemonChildPath, ...args], { timeoutMs: 60_000 });
  try {
    return JSON.parse(result.stdout) as DaemonAttempt;
  } catch {
    throw new Error(`daemon child produced no report: ${result.stderr || result.stdout}`);
  }
}

/**
 * A `git` that stops the first `status` it is asked for until a file appears, and is the real
 * `git` in every other respect. `status` is the first command the removal runs *after* taking
 * the repository lease, so blocking it holds the lease open for exactly as long as this scenario
 * wants it held.
 */
async function installBlockingGit(directory: string, markerPath: string, releasePath: string): Promise<void> {
  const realGit = resolveRealExecutablePath('git');
  await mkdir(directory, { recursive: true });
  await writeExecutableFixture(join(directory, 'git'), `const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('status')) {
  let first = false;
  try { writeFileSync(${JSON.stringify(markerPath)}, '', { flag: 'wx' }); first = true; } catch {}
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (first && !existsSync(${JSON.stringify(releasePath)})) Atomics.wait(idle, 0, 0, 25);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout ?? Buffer.alloc(0));
process.stderr.write(result.stderr ?? Buffer.alloc(0));
process.exit(result.status ?? 1);
`);
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}
