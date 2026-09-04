/**
 * Two `wtm remove` processes on one repository: exactly one gets to destroy anything.
 *
 * The race is made deterministic rather than raced for. A `git` earlier on the first child's
 * PATH blocks its first `status` call — which happens inside the removal lease, during the first
 * analysis — until this scenario releases it. The second child is run to completion inside that
 * window, so "the lease was held when the second caller asked" is a fact of the schedule and not
 * a hope about it. Racing two children and asserting the outcome set would pass just as happily
 * when the two never overlapped at all.
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

const childPath = fileURLToPath(new URL('./remove-child.ts', import.meta.url));
const fixture = await createGitSafetyFixture();
const shimRoot = await mkdtemp(join(tmpdir(), 'wtm-conflict-shim-'));
let store: SQLiteStateStore | null = null;

try {
  const secondWorktreePath = join(fixture.root, 'second feature');
  await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'feature/second', secondWorktreePath]);
  await fixture.git(secondWorktreePath, ['push', '-u', 'origin', 'feature/second']);

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

  const holder = spawnChild(
    [databasePath, globalConfigPath, fixture.repoPath, fixture.linkedWorktreePath, '-'],
    { PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ''}` },
  );
  await waitFor(markerPath, 30_000);

  const contender = runChildSync([
    databasePath, globalConfigPath, fixture.repoPath, secondWorktreePath, '-',
  ]);

  await writeFile(releasePath, '');
  const holderReport = await holder;

  process.stdout.write(`${JSON.stringify({
    holderExitCode: holderReport.exitCode,
    holderOk: holderReport.envelope.ok,
    holderWorktreeGone: !existsSync(fixture.linkedWorktreePath),
    contenderExitCode: contender.exitCode,
    contenderOk: contender.envelope.ok,
    contenderCodes: contender.envelope.errors.map(({ code }) => code),
    contenderAbandoned: contender.envelope.errors[0]?.context?.['abandoned'] ?? null,
    contenderOperation: contender.envelope.errors[0]?.context?.['operation'] ?? null,
    contenderWorktreeIntact: existsSync(secondWorktreePath),
  })}\n`);
} finally {
  store?.close();
  await rm(shimRoot, { recursive: true, force: true });
  await fixture.cleanup();
}

function spawnChild(args: readonly string[], env: Record<string, string>): Promise<ChildReport> {
  const child = spawn('node', ['--import', 'tsx', childPath, ...args], {
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
        reject(new Error(`holder child produced no report: ${stderr || stdout}`));
      }
    });
  });
}

function runChildSync(args: readonly string[]): ChildReport {
  const result = runScenario('node', ['--import', 'tsx', childPath, ...args], { timeoutMs: 60_000 });
  try {
    return JSON.parse(result.stdout) as ChildReport;
  } catch {
    throw new Error(`contender child produced no report: ${result.stderr || result.stdout}`);
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
