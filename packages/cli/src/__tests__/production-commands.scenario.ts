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
  execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
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
    'run = ["/bin/echo", "greeting"]', 'cwd = "{worktree.root}"', '',
  ].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'configure');
  const { exitCode, envelope } = await capture(['run', 'greet', '--json'], { cwd: root });
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
  const { exitCode, envelope } = await capture(['resolve', 'dev', '--json'], { cwd: root });
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
  const { exitCode, envelope } = await capture(['run', 'dev', '--json'], { cwd: root });
  const error = envelope.errors[0];
  return [
    exitCode,
    envelope.ok,
    error?.code,
    error?.message.includes('No Git repositories were found in its immediate subdirectories.'),
  ];
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
    scopedHelp: await scopedHelp(),
  }));
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
