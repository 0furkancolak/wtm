import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

/**
 * `wtm create --repos` against a real workspace of three repositories registered by `wtm init`.
 * Recovery (`--resume`) has its own scenario; this one covers creation, pre-flight and conflicts.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-create-feature-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const socketPath = join(root, 'd.sock');
const workspaceRoot = join(root, 'ws');
const gitConfig = join(root, 'gitconfig');
const repos = ['web', 'api', 'worker'] as const;

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

const create = (...argv: string[]) => invoke(['create', ...argv, '--json']);
const branchExists = (repo: string, branch: string) => {
  try { git(join(workspaceRoot, repo), 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; }
};

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

const heads: Record<string, string> = {};
for (const repo of repos) {
  const path = join(workspaceRoot, repo);
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'WTM Create');
  git(path, 'config', 'user.email', 'wtm-create@example.invalid');
  // Different content per repository, so each has its own HEAD and the pinning is observable.
  await writeFile(join(path, 'README.md'), `${repo}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', repo);
  heads[repo] = git(path, 'rev-parse', 'HEAD').trim();
}

const reconcileOk = { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never;
const initialized = await invoke(['init', '--yes', '--json'], { initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk });
if (initialized.code !== 0) throw new Error(`wtm init failed: ${initialized.stderr}`);

const created = await create('feat/auth', '--repos', 'web,api,worker');
const statusInside = await invoke(['status', '--json'], { cwd: join(workspaceRoot, 'api-feat-auth') });

const unknownName = await create('feat/unknown', '--repos', 'web,nope');

await mkdir(join(workspaceRoot, 'worker-feat-blocked'), { recursive: true });
const blocked = await create('feat/blocked', '--repos', 'web,api,worker');

const daemon = await invoke(['create', 'feat/daemon', '--repos', 'web,api', '--json'], { runtimeClient: reconcileOk });

const noRepos = await create('feat/nothing', '--resume');

// Two `[repos]` entries naming one repository make the configuration itself invalid. Written for
// this one invocation only, so no other case sees it.
const configPath = join(workspaceRoot, 'wtm.toml');
const originalConfig = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
await writeFile(configPath, `${originalConfig ?? ''}\n[repos.dup-one]\npath = "web"\n\n[repos.dup-two]\npath = "web"\n`);
let duplicateEntries: Invocation;
try {
  duplicateEntries = await create('feat/dup', '--repos', 'web');
} finally {
  if (originalConfig === null) await writeFile(configPath, '');
  else await writeFile(configPath, originalConfig);
}

process.stdout.write(JSON.stringify({
  created: {
    exitCode: created.code,
    ok: created.envelope.ok,
    featureBranch: created.envelope.data?.feature?.branch ?? null,
    featureId: typeof created.envelope.data?.feature?.id === 'string',
    registration: created.envelope.data?.registration ?? null,
    resumed: created.envelope.data?.resumed ?? null,
    warnings: created.envelope.warnings.map(({ code }) => code),
    members: (created.envelope.data?.members ?? []).map((member: any) => ({
      repository: member.repository.mainRoot.split(/[\\/]/).pop(),
      path: member.worktree?.path ?? null,
      phase: member.phase,
      created: member.branch.created,
      startPointIsOwnHead: member.branch.startPoint === heads[member.repository.mainRoot.split(/[\\/]/).pop()],
    })).sort((left: any, right: any) => left.repository.localeCompare(right.repository)),
    onDisk: repos.map((repo) => existsSync(join(workspaceRoot, `${repo}-feat-auth`))),
    expectedPaths: repos.map((repo) => join(workspaceRoot, `${repo}-feat-auth`)).sort(),
  },
  statusInside: {
    exitCode: statusInside.code,
    registered: (statusInside.envelope.data?.workspaces?.[0]?.identity?.worktreeId ?? null) !== null,
  },
  unknownName: {
    code: unknownName.envelope.errors[0]?.code ?? null,
    unknown: unknownName.envelope.errors[0]?.context?.['unknown'] ?? null,
    webCreated: existsSync(join(workspaceRoot, 'web-feat-unknown')),
  },
  blocked: {
    ok: blocked.envelope.ok,
    codes: blocked.envelope.errors.map(({ code }) => code),
    nothingWritten: !existsSync(join(workspaceRoot, 'web-feat-blocked'))
      && !existsSync(join(workspaceRoot, 'api-feat-blocked'))
      && !branchExists('web', 'feat/blocked') && !branchExists('api', 'feat/blocked'),
  },
  daemon: { ok: daemon.envelope.ok, registration: daemon.envelope.data?.registration ?? null, warnings: daemon.envelope.warnings.map(({ code }) => code) },
  noRepos: { code: noRepos.envelope.errors[0]?.code ?? null },
  duplicateEntries: {
    ok: duplicateEntries.envelope.ok,
    codes: duplicateEntries.envelope.errors.map(({ code }) => code),
    nothingWritten: !existsSync(join(workspaceRoot, 'web-feat-dup')) && !branchExists('web', 'feat/dup'),
  },
}));
