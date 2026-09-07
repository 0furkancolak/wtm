import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

/**
 * `wtm create` against a real registered workspace.
 *
 * Every case builds the same fixture — one repository registered by `wtm init` — and differs
 * only in what is asked of `create`. The production CLI opens the real state store, so this runs
 * under Node rather than in the test process.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-create-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const socketPath = join(root, 'd.sock');
const workspaceRoot = join(root, 'ws');
const mainRepo = join(workspaceRoot, 'repo');
const gitConfig = join(root, 'gitconfig');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: {
    ok: boolean;
    data: any;
    warnings: Array<{ code: string; message: string }>;
    errors: Array<{ code: string; context?: Record<string, unknown>; remediation?: unknown }>;
  };
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}): Promise<Invocation> {
  const { runCli } = await import('../main');
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    cwd: mainRepo,
    analysisDatabasePath: databasePath,
    diagnosticsDatabasePath: databasePath,
    daemonSocketPath: socketPath,
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

/** No daemon is listening in this fixture, so every `create` here takes the local path. */
async function create(...argv: readonly string[]): Promise<Invocation> {
  return await invoke(['create', ...argv, '--json']);
}

function refusal(run: Invocation, path: string): Record<string, unknown> {
  return {
    exitCode: run.code,
    ok: run.envelope.ok,
    code: run.envelope.errors[0]?.code ?? null,
    // The load-bearing half of a refusal: nothing was created.
    created: existsSync(path),
  };
}

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await mkdir(mainRepo, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

git(mainRepo, 'init', '--initial-branch=main');
git(mainRepo, 'config', 'user.name', 'WTM Create');
git(mainRepo, 'config', 'user.email', 'wtm-create@example.invalid');
await writeFile(join(mainRepo, 'README.md'), 'fixture\n');
git(mainRepo, 'add', 'README.md');
git(mainRepo, 'commit', '-m', 'fixture');
const mainHead = git(mainRepo, 'rev-parse', 'HEAD').trim();
// A second commit on a branch, so `--from` can name a ref that is not the main HEAD.
git(mainRepo, 'branch', 'base');
git(mainRepo, 'checkout', 'base');
await writeFile(join(mainRepo, 'base.txt'), 'base\n');
git(mainRepo, 'add', 'base.txt');
git(mainRepo, 'commit', '-m', 'base');
const baseHead = git(mainRepo, 'rev-parse', 'HEAD').trim();
git(mainRepo, 'checkout', 'main');

const notInitialized = await create('feat/too-early');

const initialized = await invoke(['init', '--yes', '--json'], {
  cwd: workspaceRoot,
  initDatabasePath: databasePath,
  initUserDataDir: dataRoot,
  runtimeClient: {
    request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }),
  } as never,
});
if (initialized.code !== 0) throw new Error(`wtm init failed: ${initialized.stderr}`);

const authPath = join(workspaceRoot, 'repo-feat-auth');
const auth = await create('feat/auth');
// The new worktree is registered and answers as itself, with no second `wtm init`.
const statusInside = await invoke(['status', '--json'], { cwd: authPath });

const fromRun = await create('feat/from', '--from', 'base');

// A directory already sitting where the computed path would go, for a branch checked out
// nowhere -- so the refusal is about the path and not about the branch.
const blockedPath = join(workspaceRoot, 'repo-blocked');
await mkdir(blockedPath, { recursive: true });
const occupied = await create('blocked');

// `main` is checked out in the main worktree, which is the refusal a second worktree earns.
const inUse = await create('main');
const badName = await create('feat..auth');

// A branch that exists but is checked out nowhere is checked out, not recreated.
git(mainRepo, 'branch', 'standalone', 'main');
const existingBranch = await create('standalone');
const fromExisting = await create('standalone', '--from', 'main');

process.stdout.write(JSON.stringify({
  notInitialized: {
    exitCode: notInitialized.code,
    code: notInitialized.envelope.errors[0]?.code ?? null,
    remediation: notInitialized.envelope.errors[0]?.remediation ?? null,
  },
  created: {
    exitCode: auth.code,
    ok: auth.envelope.ok,
    path: auth.envelope.data?.worktree?.path ?? null,
    expectedPath: authPath,
    branch: auth.envelope.data?.worktree?.branch ?? null,
    branchCreated: auth.envelope.data?.branch?.created ?? null,
    startPoint: auth.envelope.data?.branch?.startPoint ?? null,
    mainHead,
    registration: auth.envelope.data?.registration ?? null,
    warnings: auth.envelope.warnings.map(({ code }) => code),
    warningMentionsHooks: auth.envelope.warnings.some(({ message }) => message.includes('worktree.created')),
    tellsUserToInit: auth.envelope.warnings.some(({ message }) => message.includes('wtm init')),
    onDisk: existsSync(authPath),
  },
  statusInside: {
    exitCode: statusInside.code,
    path: statusInside.envelope.data?.workspaces?.[0]?.identity?.path ?? null,
    registered: (statusInside.envelope.data?.workspaces?.[0]?.identity?.worktreeId ?? null) !== null,
    branch: statusInside.envelope.data?.workspaces?.[0]?.identity?.branch ?? null,
  },
  from: {
    exitCode: fromRun.code,
    head: fromRun.envelope.data?.worktree?.head ?? null,
    baseHead,
    startPoint: fromRun.envelope.data?.branch?.startPoint ?? null,
  },
  occupied: {
    ...refusal(occupied, join(workspaceRoot, 'repo-blocked-2')),
    path: occupied.envelope.errors[0]?.context?.['path'] ?? null,
    expectedPath: blockedPath,
  },
  inUse: {
    ...refusal(inUse, join(workspaceRoot, 'repo-main')),
    worktreePath: inUse.envelope.errors[0]?.context?.['worktreePath'] ?? null,
  },
  badName: refusal(badName, join(workspaceRoot, 'repo-feat..auth')),
  existingBranch: {
    exitCode: existingBranch.code,
    branchCreated: existingBranch.envelope.data?.branch?.created ?? null,
    startPoint: existingBranch.envelope.data?.branch?.startPoint ?? null,
  },
  fromExisting: refusal(fromExisting, join(workspaceRoot, 'repo-standalone-2')),
}));
