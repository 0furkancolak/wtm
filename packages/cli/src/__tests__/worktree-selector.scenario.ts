import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

/**
 * The seven task commands (`resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`) reach the
 * selected worktree of a two-repository workspace from its root, via `--worktree`/`--repo`
 * (design `docs/superpowers/specs/2026-09-14-worktree-selector-design.md`, §1, §3, §4). Modelled
 * on `create-feature.scenario.ts`'s setup (temporary root, isolated `HOME`, a reconcile-only
 * `runtimeClient` for `init`), with repositories `web` and `api` instead of three.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-worktree-selector-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const socketPath = join(root, 'd.sock');
const workspaceRoot = join(root, 'ws');
const gitConfig = join(root, 'gitconfig');
const repos = ['web', 'api'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: { ok: boolean; data: any; warnings: Array<{ code: string }>; errors: Array<{ code: string; context?: Record<string, unknown>; remediation?: unknown }> };
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}): Promise<Invocation> {
  const { runCli } = await import('../main');
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    cwd: workspaceRoot,
    analysisDatabasePath: databasePath,
    diagnosticsDatabasePath: databasePath,
    removalGlobalConfigPath: join(dataRoot, 'config.toml'),
    daemonSocketPath: socketPath,
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

for (const repo of repos) {
  const path = join(workspaceRoot, repo);
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'WTM Worktree Selector');
  git(path, 'config', 'user.email', 'wtm-worktree-selector@example.invalid');
  await writeFile(join(path, 'README.md'), `${repo}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', repo);
}

const reconcileOk = { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never;
const initialized = await invoke(['init', '--yes', '--json'], { initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk });
if (initialized.code !== 0) throw new Error(`wtm init failed: ${initialized.stderr}`);

// A task to resolve, so `resolve --worktree` has something to report the working directory of.
await writeFile(join(workspaceRoot, 'wtm.toml'), `${await readFile(join(workspaceRoot, 'wtm.toml'), 'utf8')}\n[tasks.dev]\nrun = ["node", "-e", "0"]\n`);
const created = await invoke(['create', 'feat/auth', '--repos', 'web,api', '--json'], { runtimeClient: reconcileOk });
if (created.code !== 0 || created.envelope.ok !== true) throw new Error(`wtm create failed: ${created.stderr || JSON.stringify(created.envelope)}`);

// `create-feature.scenario.ts` names linked worktrees `${repo}-feat-auth`, beside the repository;
// read them back from the response instead of assuming the convention holds here too.
const memberPath = (repo: string): string => {
  const member = (created.envelope.data.members as Array<{ repository: { mainRoot: string }; worktree: { path: string } | null }>)
    .find((candidate) => candidate.repository.mainRoot === join(workspaceRoot, repo));
  if (member?.worktree?.path === undefined) throw new Error(`no created worktree for ${repo}`);
  return member.worktree.path;
};
const apiAuth = memberPath('api');
const webAuth = memberPath('web');

const requests: Array<{ command: string; arguments: any }> = [];
const recording = {
  request: async (command: string, args: unknown) => {
    requests.push({ command, arguments: args });
    if (command === 'exec') {
      return { schemaVersion: 1, ok: true, command, data: { argv: ['true'], cwd: (args as { cwd: string }).cwd, envDelta: {} }, warnings: [], errors: [] };
    }
    // `jobs.enqueue` (the `run --enqueue` request) is validated against `enqueueAcceptanceSchema`
    // (`packages/protocol/src/jobs.ts`), which requires more than `{ accepted: true }`: a job ID,
    // scheduling state, and the caller's own idempotency key echoed back.
    if (command === 'jobs.enqueue') {
      const idempotencyKey = (args as { idempotencyKey: string }).idempotencyKey;
      return { schemaVersion: 1, ok: true, command, data: { accepted: true, jobId: 'job-1', state: 'QUEUED', idempotencyKey, reused: false }, warnings: [], errors: [] };
    }
    return { schemaVersion: 1, ok: true, command, data: { accepted: true }, warnings: [], errors: [] };
  },
} as never;
const target = { taskTargetDatabasePath: databasePath, taskTargetGlobalConfigPath: join(dataRoot, 'config.toml'), runtimeClient: recording, execForeground: async () => ({ exitCode: 0, signal: null }) };

const results = {
  start: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  stop: await invoke(['stop', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  restart: await invoke(['restart', 'dev', '--worktree', 'api-feat-auth', '--json'], target),
  logs: await invoke(['logs', 'dev', '--worktree', apiAuth, '--json'], target),
  exec: await invoke(['exec', '--worktree', 'feat/auth', '--repo', 'api', '--json', '--', 'true'], target),
  enqueue: await invoke(['run', 'dev', '--enqueue', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  ambiguous: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--json'], target),
  unknownRepo: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--repo', 'nope', '--json'], target),
  workspaceRoot: await invoke(['start', 'dev', '--json'], target),
  resolveTarget: await invoke(['resolve', 'dev', '--worktree', 'feat/auth', '--repo', 'web', '--json'], target),
};

process.stdout.write(`${JSON.stringify({ apiAuth, webAuth, requests, results })}\n`);
