import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import type { CliDependencies } from '../../../cli/src/main';
import { writeExecutableFixture } from '../../../testkit/src/executable-fixture';
import { createGhRunner } from '../ci/gh-runner';
import { createGitHubProvider } from '../ci/github-provider';
import { CiWatcher } from '../ci/watcher';

/**
 * The one place a real daemon-side `CiWatcher` is driven by the real CLI `wtm ci` commands, with a
 * fake `gh` standing in for GitHub and a fake clock standing in for real time.
 *
 * Workspace setup follows `worktree-selector.scenario.ts` (temporary root, isolated `HOME`, a
 * private data root, `wtm init --yes --json` through `runCli` with `initDatabasePath` and
 * `initUserDataDir`, and a reconcile-only `runtimeClient`) with a single repository, the way
 * `full-workflow.scenario.ts` inits a repository at the workspace root directly. `runCli` is
 * imported from the CLI package the way `readiness-http.scenario.ts` does.
 *
 * `SQLiteStateStore` cannot be constructed inside a `bun test` process (better-sqlite3 panics
 * under Bun's own N-API bridge, `watcher.scenario.ts`'s header explains why), so this file is run
 * under plain `node` by `ci-watch-scenario.test.ts`, the way `heavy-job-finalization.test.ts`
 * drives its own `.scenario.ts`.
 *
 * `ci watch`/`ci status`/`ci unwatch` reach the daemon through a `runtimeClient` stub that forwards
 * straight into `CiWatcher#handle` — there is no real IPC socket here, only the same request shape
 * a real `DaemonClient` would send. `ci status` never goes through that client at all: it reads the
 * same on-disk `SQLiteStateStore` directly, the way the real CLI does, so this also proves the
 * daemon's writes and the CLI's reads agree on one database file (WAL mode allows the concurrent
 * read-only connections `ci status` opens while the watcher's own connection stays open for the
 * whole run).
 */

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-ci-watch-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const gitConfig = join(root, 'gitconfig');
// A single-repository workspace: the repository root doubles as the workspace root, the same
// shape `full-workflow.scenario.ts` inits (`cwd: main` there, not a separate parent directory).
const repo = join(root, 'repo');
const workspaceRoot = repo;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: {
    ok: boolean;
    command: string;
    data: any;
    warnings: Array<{ code: string }>;
    errors: Array<{ code: string; context?: Record<string, unknown>; remediation?: unknown }>;
  };
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}): Promise<Invocation> {
  const { runCli } = await import('../../../cli/src/main');
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    cwd: workspaceRoot,
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

try {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
  process.env['HOME'] = home;
  process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
  process.env['GIT_CONFIG_NOSYSTEM'] = '1';

  await mkdir(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'WTM CI Watch');
  git(repo, 'config', 'user.email', 'wtm-ci-watch@example.invalid');
  await writeFile(join(repo, 'README.md'), 'widgets\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  // A repository whose origin is a GitHub URL; no network call is ever made against it.
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');

  const reconcileOk = {
    request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }),
  } as never;
  const initialized = await invoke(['init', '--yes', '--json'], {
    initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk,
  });
  if (initialized.code !== 0 || initialized.envelope.ok !== true) {
    throw new Error(`wtm init failed: ${initialized.stderr || JSON.stringify(initialized.envelope)}`);
  }

  // A fake `gh` that serves a run that is in progress on the first poll and failed afterwards.
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const counter = join(root, 'gh-calls.json');
  await writeExecutableFixture(join(bin, 'gh'), `
    const { existsSync, readFileSync, writeFileSync } = require('node:fs');
    const args = process.argv.slice(2);
    const path = ${JSON.stringify(counter)};
    const calls = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    calls.push(args);
    writeFileSync(path, JSON.stringify(calls));
    const listed = calls.filter((call) => call[0] === 'run' && call[1] === 'list').length;
    if (args[0] === 'auth') process.exit(0);
    if (args[0] === 'run' && args[1] === 'list') {
      const done = listed > 1;
      process.stdout.write(JSON.stringify([{ databaseId: 501, workflowName: 'CI', event: 'push', status: done ? 'completed' : 'in_progress', conclusion: done ? 'failure' : '', url: 'https://github.com/acme/widgets/actions/runs/501' }]));
      process.exit(0);
    }
    if (args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed')) {
      const lines = [];
      for (let i = 0; i < 50; i += 1) lines.push('test\\tUNKNOWN STEP\\t2026-09-14T11:00:00.0000000Z line ' + i);
      lines[45] = 'test\\tUNKNOWN STEP\\t2026-09-14T11:00:00.0000000Z ##[error]expected 2 to be 3 (token ghp_abcdefghijklmnopqrstuvwxyz0123)';
      process.stdout.write(lines.join('\\n'));
      process.exit(0);
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const done = listed > 1;
      process.stdout.write(JSON.stringify({ jobs: [{ databaseId: 601, name: 'test', status: done ? 'completed' : 'in_progress', conclusion: done ? 'failure' : '', url: 'https://github.com/acme/widgets/actions/runs/501/job/601' }] }));
      process.exit(0);
    }
    process.stderr.write('unexpected gh call ' + JSON.stringify(args));
    process.exit(2);
  `);

  const store = new SQLiteStateStore(databasePath);
  try {
    let now = Date.parse('2026-09-14T12:00:00.000Z');
    type Timer = { at: number; callback: () => void };
    const timers: Timer[] = [];
    const clock = {
      now: () => now,
      setTimeout: (callback: () => void, delayMs: number) => {
        const timer: Timer = { at: now + delayMs, callback };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle: unknown) => {
        const index = timers.indexOf(handle as Timer);
        if (index >= 0) timers.splice(index, 1);
      },
    };
    const watcher = new CiWatcher({
      store: store.ci,
      registration: store,
      provider: createGitHubProvider(createGhRunner({ env: { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` } })),
      clock,
    });
    try {
      await watcher.start();
      const advance = async (ms: number) => {
        const target = now + ms;
        for (;;) {
          timers.sort((left, right) => left.at - right.at);
          const next = timers[0];
          if (next === undefined || next.at > target) break;
          timers.shift();
          now = next.at;
          next.callback();
          await watcher.idle();
        }
        now = target;
      };
      const forwarding = {
        request: async (command: string, args: unknown) => await watcher.handle({
          protocol: { major: 1, minor: 0 }, id: 'scenario', command, arguments: args,
        }),
      };
      const target = {
        taskTargetDatabasePath: databasePath,
        taskTargetGlobalConfigPath: join(dataRoot, 'config.toml'),
        runtimeClient: forwarding as never,
      };

      const watched = await invoke(['ci', 'watch', '--pr', '12', '--json'], { ...target, cwd: repo });
      const pendingStatus = await invoke(['ci', 'status', '--json'], { ...target, cwd: repo });
      await advance(15_000);
      const afterFirstPoll = await invoke(['ci', 'status', '--json'], { ...target, cwd: repo });
      await advance(15_000);
      const finalStatus = await invoke(['ci', 'status', '--json'], { ...target, cwd: repo });
      const all = await invoke(['ci', 'status', '--all', '--json'], { ...target, cwd: workspaceRoot });

      process.stdout.write(`${JSON.stringify({
        watched, pendingStatus, afterFirstPoll, finalStatus, all, calls: JSON.parse(await readFile(counter, 'utf8')),
      })}\n`);
    } finally {
      await watcher.close();
    }
  } finally {
    store.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
