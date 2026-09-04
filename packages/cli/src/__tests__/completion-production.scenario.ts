import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { runCli, type CliDependencies } from '../main';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-completion-production-')));
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
  return { exitCode, lines: output.split('\n').filter((line) => line.length > 0) };
}

/**
 * The unregistered fallback: a plain `wtm.toml` in a repository nobody ran `wtm init` in, which
 * is the only path `productionTaskNames` has when `completionDatabasePath` names no database.
 */
async function taskNamesFromWtmToml() {
  const root = await temporaryRoot();
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 'production@example.invalid');
  git(root, 'config', 'user.name', 'WTM Production');
  await writeFile(join(root, 'wtm.toml'), [
    'version = 1', '', '[workspace]', 'name = "production"', '',
    '[tasks.build]', 'run = ["/bin/echo", "build"]', 'cwd = "{worktree.root}"', '',
    '[tasks.dev]', 'run = ["/bin/echo", "dev"]', 'cwd = "{worktree.root}"', '',
  ].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'configure');
  const missingDatabasePath = join(root, 'no-such-state.db');
  const { exitCode, lines } = await capture(
    ['__complete', 'tasks'],
    { cwd: root, completionDatabasePath: missingDatabasePath },
  );
  return [exitCode, lines];
}

/** A linked worktree's branch name is a valid `analyze`/`remove` selector. */
async function worktreeSelectorsFromGitTopology() {
  const root = await temporaryRoot();
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 'production@example.invalid');
  git(root, 'config', 'user.name', 'WTM Production');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
  const linked = join(root, 'linked-worktree');
  git(root, 'worktree', 'add', '-b', 'feature/completion', linked);
  const missingDatabasePath = join(root, 'no-such-state.db');
  const { exitCode, lines } = await capture(
    ['__complete', 'worktrees'],
    { cwd: root, completionDatabasePath: missingDatabasePath },
  );
  return [exitCode, lines];
}

/** A registered workspace's name is a valid `forget` selector. */
async function repoSelectorsFromStateStore() {
  const root = await temporaryRoot();
  const databasePath = join(root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  store.upsertWorkspace({ name: 'production', root, scope: 'local', configPath: join(root, 'wtm.toml') });
  store.close();
  const { exitCode, lines } = await capture(
    ['__complete', 'repos'],
    { cwd: root, completionDatabasePath: databasePath },
  );
  return [exitCode, lines];
}

try {
  await writeFile(process.argv[2] as string, JSON.stringify({
    taskNamesFromWtmToml: await taskNamesFromWtmToml(),
    worktreeSelectorsFromGitTopology: await worktreeSelectorsFromGitTopology(),
    repoSelectorsFromStateStore: await repoSelectorsFromStateStore(),
  }));
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
