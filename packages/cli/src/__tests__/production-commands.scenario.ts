import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { runCli, type CliDependencies } from '../main';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-production-')));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function capture(argv: readonly string[], dependencies: CliDependencies) {
  let output = '';
  const exitCode = await runCli(argv, {
    ...dependencies,
    stdout: (value) => { output += value; },
    stderr: () => {},
  });
  return {
    exitCode,
    envelope: JSON.parse(output) as {
      ok: boolean;
      data: Record<string, any> | null;
      errors: Array<{ code: string; message: string; context?: Record<string, unknown> }>;
    },
  };
}

async function registeredStatus() {
  const root = await temporaryRoot();
  const databasePath = join(root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  store.upsertWorkspace({ name: 'production', root, scope: 'local', configPath: join(root, 'wtm.toml') });
  store.close();
  const { exitCode, envelope } = await capture(['status', '--json'], { cwd: root, diagnosticsDatabasePath: databasePath });
  const entry = envelope.data?.['workspaces']?.[0];
  return [exitCode, envelope.ok, entry?.workspace?.name, entry?.identity?.path === root];
}

async function uninitializedStatus() {
  const root = await temporaryRoot();
  const { exitCode, envelope } = await capture(['status', '--json'], {
    cwd: root, diagnosticsDatabasePath: join(root, 'missing.db'),
  });
  return [exitCode, envelope.ok, envelope.errors[0]?.code];
}

async function foregroundRun() {
  const root = await temporaryRoot();
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 'production@example.invalid');
  git(root, 'config', 'user.name', 'WTM Production');
  await writeFile(join(root, 'wtm.toml'), [
    'version = 1', '', '[workspace]', 'name = "production"', '',
    '[tasks.greet]', 'description = "Print a fixed greeting."',
    `run = ${JSON.stringify(['node', '-e', 'console.log("greeting")'])}`, 'cwd = "{worktree.root}"', '',
  ].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'configure');
  const { exitCode, envelope } = await capture(['run', 'greet', '--json'], {
    cwd: root, taskTargetDatabasePath: join(root, 'task-target-state.db'), taskTargetGlobalConfigPath: join(root, 'task-target-global.toml'),
  });
  return [exitCode, envelope.ok, envelope.data?.['task']?.argv, envelope.data?.['exitCode']];
}

/**
 * README's multi-repo layout: a workspace root that holds several repositories as
 * subdirectories without being one itself. `resolve` used to run `git worktree list` against
 * that root directly and leak git's own -- locale-dependent -- "not a git repository" stderr
 * under the wrong error code, `WTM_CONFIG_INVALID` (todo.md item 43). The assertions below are
 * on WTM's own fixed English text, never on git's, so they hold regardless of which locale the
 * git binary that produced the exit-128 failure happens to be running in.
 */
async function multiRepoRootResolve() {
  const root = await temporaryRoot();
  git(root, 'init', '-q', '-b', 'main', 'api');
  git(root, 'init', '-q', '-b', 'main', 'web');
  const { exitCode, envelope } = await capture(['resolve', 'dev', '--json'], {
    cwd: root, taskTargetDatabasePath: join(root, 'task-target-state.db'), taskTargetGlobalConfigPath: join(root, 'task-target-global.toml'),
  });
  const error = envelope.errors[0];
  const message = error?.message ?? '';
  return [
    exitCode,
    envelope.ok,
    error?.code,
    message.startsWith(`${root} is not a Git repository.`),
    // Git's own English fatal text for this condition contains "fatal" and "not a git
    // repository" verbatim; their absence here is what shows the message is WTM's fixed text
    // rather than an interpolation of whatever git printed.
    message.toLowerCase().includes('fatal'),
    'stderr' in (error?.context ?? {}),
    error?.context?.['discoveredRepositories'],
  ];
}

/** The same condition reached through `run`, with nothing underneath to suggest cd'ing into. */
async function multiRepoRootRunWithoutRepositories() {
  const root = await temporaryRoot();
  const { exitCode, envelope } = await capture(['run', 'dev', '--json'], {
    cwd: root, taskTargetDatabasePath: join(root, 'task-target-state.db'), taskTargetGlobalConfigPath: join(root, 'task-target-global.toml'),
  });
  const error = envelope.errors[0];
  return [
    exitCode,
    envelope.ok,
    error?.code,
    error?.message.includes('No Git repositories were found in its immediate subdirectories.'),
  ];
}

/**
 * `wtm resolve` reports; it must not lease. It used to take a port for every endpoint of the
 * feature on the way to an answer, so an agent's repeated `resolve` calls in a worktree whose
 * leases had gone (a release, a rename) returned a new port each time while the task ran on
 * another.
 */
async function resolveDoesNotLease() {
  const root = await temporaryRoot();
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 'production@example.invalid');
  git(root, 'config', 'user.name', 'WTM Production');
  await writeFile(join(root, 'wtm.toml'), [
    'version = 1', '', '[workspace]', 'name = "production"', '',
    '[ports]', 'range = "46100-46199"', '[ports.web]', 'preferred = 46150', '',
    '[tasks.serve]', `run = ${JSON.stringify(['node', '-e', 'void 0', '{port.web}'])}`, '',
  ].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'configure');
  const databasePath = join(root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  const workspace = store.upsertWorkspace({ name: 'production', root, scope: 'local', configPath: join(root, 'wtm.toml') });
  const repository = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: join(root, '.git'), mainRoot: root, remoteIdentity: null });
  store.reconcileWorktrees(repository.id, [{
    path: root, head: 'head', branch: 'refs/heads/main', detached: false, bare: false, lockedReason: null, prunableReason: null,
  }]);
  store.close();
  const dependencies = { cwd: root, taskTargetDatabasePath: databasePath, taskTargetGlobalConfigPath: join(root, 'global.toml') };
  const leases = () => {
    const reader = new SQLiteStateStore(databasePath);
    try { return reader.listEndpointLeases().map(({ port, state, allocatedAt }) => ({ port, state, allocatedAt })); }
    finally { reader.close(); }
  };

  const unleased = await capture(['resolve', 'serve', '--json'], dependencies);
  const leasesBefore = leases().length;
  const ran = await capture(['run', 'serve', '--json'], dependencies);
  const afterRun = leases();
  const first = await capture(['resolve', 'serve', '--json'], dependencies);
  const second = await capture(['resolve', 'serve', '--json'], dependencies);
  return {
    unleased: [unleased.exitCode, unleased.envelope.errors[0]?.code, unleased.envelope.errors[0]?.context?.['endpoint'],
      unleased.envelope.errors[0]?.message.includes('has no port leased yet')],
    leasesBefore,
    ran: [ran.exitCode, ran.envelope.data?.['task']?.argv?.[3]],
    // `resolve`'s data is the resolved task itself; `run`'s wraps it with the exit status.
    resolvedPorts: [first.envelope.data?.['argv']?.[3], second.envelope.data?.['argv']?.[3]],
    leasesUnchanged: JSON.stringify(leases()) === JSON.stringify(afterRun),
  };
}

async function scopedHelp() {
  const describe = async (argv: readonly string[]) => {
    let output = '';
    await runCli(argv, { stdout: (value) => { output += value; }, stderr: () => {} });
    return /--global\s{2,}(.+)/.exec(output)?.[1]?.trim();
  };
  return [await describe(['init', '--help']), await describe(['skill', 'install', '--help'])];
}

try {
  // A foreground task inherits stdout, so the scenario reports through a file instead.
  await writeFile(process.argv[2] as string, JSON.stringify({
    registeredStatus: await registeredStatus(),
    uninitializedStatus: await uninitializedStatus(),
    foregroundRun: await foregroundRun(),
    multiRepoRootResolve: await multiRepoRootResolve(),
    multiRepoRootRunWithoutRepositories: await multiRepoRootRunWithoutRepositories(),
    resolveDoesNotLease: await resolveDoesNotLease(),
    scopedHelp: await scopedHelp(),
  }));
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
