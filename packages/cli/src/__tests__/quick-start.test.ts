import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scenarioTimeoutMs } from '../../../testkit/src/scenario-child';

/**
 * The README quick start is the first thing anyone runs, and until this test existed it did not
 * work: it called `wtm resolve dev` fifty lines before the README explained that tasks have to be
 * defined, so a clean workspace answered `Unknown task: dev` (`todo.md` item 37).
 *
 * The commands are read out of `README.md` rather than transcribed here. A test carrying its own
 * copy proves the copy works and lets the README rot independently, which is precisely the failure
 * item 37 documents — so the only thing this file knows about the quick start is where to find it.
 */
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

test('every command in the README quick start succeeds in a clean workspace', () => {
  const commands = quickStartCommands();
  // A quick start that stops before it has done anything would pass an empty loop.
  expect(commands.length, 'the README quick start block is empty').toBeGreaterThan(1);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wtm-quick-start-')));
  try {
    const workspace = prepareWorkspace(root);
    const environment = isolatedEnvironment(root);

    // The first line is the reader's `cd`; standing in the temporary workspace is this test's
    // version of following it. Anything else has to run, exactly as written, and exit 0.
    const [entry, ...rest] = commands;
    expect(entry, 'the quick start must begin with a `cd` into the reader\'s own workspace')
      .toMatch(/^cd\s+\S+$/);

    for (const command of rest) {
      expect(command, 'this test can only follow one `cd`, the first line').not.toMatch(/^cd(\s|$)/);
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: workspace, env: environment, encoding: 'utf8', timeout: scenarioTimeoutMs,
      });
      expect(result.status, `${command}\n${result.stderr || ''}${result.stdout || ''}`).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, scenarioTimeoutMs);

/** The commands of the first fenced block under `## Quick start`, comments and blanks dropped. */
function quickStartCommands(): string[] {
  const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
  const afterHeading = readme.split(/^## Quick start$/m)[1];
  if (afterHeading === undefined) throw new Error('README.md has no "## Quick start" section.');
  const section = afterHeading.split(/^## /m)[0] ?? '';
  const block = /^```bash\n([\s\S]*?)^```$/m.exec(section);
  if (block?.[1] === undefined) throw new Error('The README quick start has no ```bash block.');
  return block[1].split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * What the reader has when they arrive: a Git repository with one commit, no `Makefile`, no
 * `wtm.toml`, and no adapter of any kind. `resolve` answers for the worktree the reader is
 * standing in, so the workspace root being a repository is part of following the instructions.
 */
function prepareWorkspace(root: string): string {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const git = (...args: string[]): void => { execFileSync('/usr/bin/git', args, { cwd: workspace }); };
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'WTM Quick Start');
  git('config', 'user.email', 'wtm-quick-start@example.invalid');
  writeFileSync(join(workspace, 'app.txt'), 'fixture\n');
  git('add', 'app.txt');
  git('commit', '-q', '-m', 'fixture');
  return workspace;
}

/**
 * A `HOME` of this run's own, so the quick start neither reads nor writes the state of the machine
 * running the suite, and a `wtm` on `PATH` that is this working tree rather than whatever is
 * installed on it. Building the standalone executable first would test the release rather than the
 * README, and cost a minute per run to do it.
 */
function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, 'home');
  const binaries = join(root, 'bin');
  const gitConfig = join(root, 'gitconfig');
  for (const directory of [home, binaries]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(gitConfig, '');
  const shim = join(binaries, 'wtm');
  const loader = pathToFileURL(join(repositoryRoot, 'node_modules/tsx/dist/loader.mjs')).href;
  const entry = join(repositoryRoot, 'packages/cli/src/bin.ts');
  // The loader is addressed absolutely because the shim runs with the workspace as its working
  // directory, where `tsx` does not resolve.
  writeFileSync(shim, `#!/bin/sh\nexec node --import '${loader}' '${entry}' "$@"\n`);
  chmodSync(shim, 0o700);

  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('WTM_')) delete environment[name];
  return {
    ...environment,
    HOME: home,
    PATH: `${binaries}:${environment['PATH'] ?? ''}`,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
