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
      errors: Array<{ code: string }>;
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
    scopedHelp: await scopedHelp(),
  }));
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
