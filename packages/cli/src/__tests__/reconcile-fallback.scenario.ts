import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

/**
 * A worktree created with `git worktree add` after `wtm init`, and who notices it.
 *
 * Every case here builds the same fixture — a registered workspace whose registry was written
 * while only the main worktree existed — and then differs only in who is running when the read
 * command asks about the new worktree.
 */
const scenario = process.argv[2] ?? '';

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-b7-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
// Short on purpose: a Unix socket address has a byte limit, and a temporary directory is
// already most of it.
const socketPath = join(root, 'd.sock');
const workspaceRoot = join(root, 'ws');
const mainRepo = join(workspaceRoot, 'repo');
const linked = join(workspaceRoot, 'repo-feature');
const unrelated = join(workspaceRoot, 'notes');
const gitConfig = join(root, 'gitconfig');

function git(cwd: string, ...args: string[]): string {
  // `execFileSync` inherits stderr by default, and `git worktree add` narrates on it; this
  // scenario reports through stdout, so nothing of Git's may reach either stream.
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: {
    ok: boolean;
    data: { workspaces: Array<Record<string, any>> } | null;
    errors: Array<{ code: string }>;
  };
}

async function invoke(argv: readonly string[], dependencies: CliDependencies): Promise<Invocation> {
  const { runCli } = await import('../main');
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

/** The read command every case asks, from inside the worktree the registry has not heard of. */
async function statusIn(cwd: string): Promise<Invocation> {
  return await invoke(['status', '--json'], {
    cwd,
    diagnosticsDatabasePath: databasePath,
    daemonSocketPath: socketPath,
  });
}

function identityOf(status: Invocation): Record<string, unknown> {
  const entry = status.envelope.data?.workspaces?.[0];
  return {
    exitCode: status.code,
    ok: status.envelope.ok,
    path: entry?.['identity']?.path ?? null,
    registered: (entry?.['identity']?.worktreeId ?? null) !== null,
    branch: entry?.['identity']?.branch ?? null,
    stderr: status.stderr,
  };
}

async function listen(): Promise<Server> {
  const server = createServer();
  await new Promise<void>((settle, fail) => {
    server.once('error', fail);
    server.listen(socketPath, () => { settle(); });
  });
  return server;
}

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await mkdir(mainRepo, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

try {
  git(mainRepo, 'init', '--initial-branch=main');
  git(mainRepo, 'config', 'user.name', 'WTM B7');
  git(mainRepo, 'config', 'user.email', 'wtm-b7@example.invalid');
  await writeFile(join(mainRepo, 'README.md'), 'fixture\n');
  git(mainRepo, 'add', 'README.md');
  git(mainRepo, 'commit', '-m', 'fixture');

  const initialized = await invoke(['init', '--yes', '--json'], {
    cwd: workspaceRoot,
    initDatabasePath: databasePath,
    initUserDataDir: dataRoot,
    daemonSocketPath: socketPath,
    // Registering tells a running daemon to re-read its registrations; this fixture has none,
    // and must never reach the one on the machine running the suite.
    runtimeClient: {
      request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }),
    } as never,
  });
  if (initialized.code !== 0) throw new Error(`wtm init failed: ${initialized.stderr}`);

  // The whole defect in one line: this writes nothing WTM owns, so the registry written above
  // is now out of date and nothing has told it so.
  git(mainRepo, 'worktree', 'add', '-b', 'feature', linked);

  const report = await run();
  process.stdout.write(JSON.stringify(report));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function run(): Promise<Record<string, unknown>> {
  switch (scenario) {
    case 'daemon-returns': return await daemonReturns();
    case 'daemon-down': return await daemonDown();
    case 'daemon-up': return await daemonUp();
    case 'unrelated-directory': return await unrelatedDirectory();
    case 'unwritable-registry': return await unwritableRegistry();
    default: throw new Error(`unknown scenario: ${scenario}`);
  }
}

/**
 * Characterization: the daemon comes back, and its startup reconcile is the only thing that
 * could have found the worktree — the watcher is stubbed out so a pass it scheduled cannot.
 */
async function daemonReturns(): Promise<Record<string, unknown>> {
  const { SQLiteStateStore } = await import('@wtm/core');
  const { WtmDaemon } = await import('@wtm/daemon');
  const store = new SQLiteStateStore(databasePath);
  const daemon = new WtmDaemon({
    stateStore: store,
    socketPath,
    watcherFactory: () => ({
      start: async () => {},
      close: async () => {},
      whenIdle: async () => {},
    }),
  });
  await daemon.start();
  try {
    return { status: identityOf(await statusIn(linked)) };
  } finally {
    await daemon.close();
    store.close();
  }
}

/** The daemon is not running, so nobody has reconciled and nobody else will. */
async function daemonDown(): Promise<Record<string, unknown>> {
  // `wtm env` is where the defect was reported, and it goes through the throwing lookup.
  const env = await invoke(['env', '--json'], {
    cwd: linked, diagnosticsDatabasePath: databasePath, daemonSocketPath: socketPath,
  });
  const status = await statusIn(linked);
  // The second lookup, through `findRegistration`, must agree that the worktree is registered.
  const doctor = await invoke(['doctor', '--json'], {
    cwd: linked, diagnosticsDatabasePath: databasePath, daemonSocketPath: socketPath,
  });
  const registration = doctor.envelope.data?.workspaces?.[0]?.['findings']
    ?.find((finding: { check: string }) => finding.check === 'registration');
  return {
    // `env` runs first, so this is the command that did the reconciling and said so.
    env: {
      exitCode: env.code,
      ok: env.envelope.ok,
      error: env.envelope.errors[0]?.code ?? null,
      stderr: env.stderr,
    },
    status: identityOf(status),
    registrationFinding: {
      status: registration?.status ?? null,
      registered: registration?.details?.registered ?? null,
      daemonReachable: registration?.details?.daemonReachable ?? null,
    },
  };
}

/**
 * A daemon is answering on the socket. The registry is its to write, and it reconciles this
 * repository itself; a second writer behind its back is not a read command's business.
 */
async function daemonUp(): Promise<Record<string, unknown>> {
  const server = await listen();
  try {
    return { status: identityOf(await statusIn(linked)) };
  } finally {
    await new Promise<void>((settle) => { server.close(() => { settle(); }); });
  }
}

/** An ordinary directory in the workspace that is in no repository at all. */
async function unrelatedDirectory(): Promise<Record<string, unknown>> {
  await mkdir(unrelated, { recursive: true, mode: 0o700 });
  return { status: identityOf(await statusIn(unrelated)) };
}

/**
 * A registry nobody may write to.
 *
 * Not the reconciling write failing — measured, and it never gets that far: opening the store
 * sets `journal_mode = WAL`, which is itself a write, so an unwritable registry directory is
 * refused at `openStateStore` and the fallback is never reached. Kept because that is the
 * question anyone reading a read command that writes will ask, and the answer is that the
 * command still ends in one coded envelope rather than a crash.
 */
async function unwritableRegistry(): Promise<Record<string, unknown>> {
  await chmod(dataRoot, 0o500);
  try {
    const status = await statusIn(linked);
    return {
      status: identityOf(status),
      error: status.envelope.errors[0]?.code ?? null,
    };
  } finally {
    await chmod(dataRoot, 0o700);
  }
}
