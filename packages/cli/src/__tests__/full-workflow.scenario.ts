import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import { publishedDaemonSocketPath } from '@wtm/platform/socket';
import { isolatedHomeEnvironment } from '../../../testkit/src/isolated-home';
import type { CliDependencies } from '../main';

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-e2e-')));
const home = join(root, 'home');
/**
 * The whole environment that confines this run to `home`, not `HOME` alone.
 *
 * On macOS the two are the same thing. On Linux the XDG variables are read from the ambient
 * environment and override what `HOME` implies, so a scenario that set only `HOME` would keep
 * reading and writing the runner's own state root and socket directory — the machine this fixture
 * exists to stay off. It is assigned onto `process.env` because everything below inherits it:
 * `runCli` runs in this process and `git()` passes `process.env` straight through.
 */
Object.assign(process.env, isolatedHomeEnvironment(home));
/**
 * Where this platform puts WTM's files, asked rather than spelled out.
 *
 * The three paths below used to be `home/Library/...`, which is the host's answer only on macOS.
 * On Linux they named directories WTM would never touch, so `serviceRootUntouched` and
 * `socketAbsent` — the two claims here that a service was *not* installed and a daemon was *not*
 * started — became vacuously true exactly where a second service manager exists to install into
 * (D3, D4). Derived from the isolated environment, both mean the same thing on either platform.
 */
const hostPaths = selectPlatformRuntime({ home, env: process.env }).paths;
const serviceRoot = hostPaths.serviceRoot;
const dataRoot = hostPaths.dataRoot;
const databasePath = join(dataRoot, 'state.db');
const socketPath = publishedDaemonSocketPath(hostPaths.socketRoot);
const gitConfig = join(root, 'gitconfig');
const remote = join(root, 'remote.git');
const main = join(root, 'workspace', 'repo');
const nested = join(main, 'src');
const linked = join(root, 'linked-feature');
/**
 * The premise, checked before anything is created from it.
 *
 * `serviceRootUntouched` and `socketAbsent` below are claims that WTM did *not* write something.
 * A claim of that shape is true of every directory in the world, so it is worth nothing unless the
 * directory it names is one this fixture owns — and it is a derivation away from naming the
 * runner's. Failing here rather than reporting `true` about somebody else's `~/.config` is the
 * difference between a green run and a green run that proves nothing.
 */
const escaped = Object.entries({ serviceRoot, dataRoot, socketPath })
  .filter(([, path]) => !path.startsWith(`${home}/`));
if (escaped.length > 0) {
  await rm(root, { recursive: true, force: true });
  throw new Error(`Fixture paths escaped ${home}: ${escaped.map(([name, path]) => `${name}=${path}`).join(', ')}`);
}

await mkdir(serviceRoot, { recursive: true, mode: 0o700 });
await mkdir(main, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

try {
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(main, 'init', '--initial-branch=main');
  git(main, 'config', 'user.name', 'WTM E2E');
  git(main, 'config', 'user.email', 'wtm-e2e@example.invalid');
  await writeFile(join(main, 'README.md'), 'fixture\n');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  await writeFile(join(nested, 'index.ts'), 'export {};\n');
  git(main, 'add', 'README.md');
  git(main, 'add', 'src/index.ts');
  git(main, 'commit', '-m', 'fixture');
  git(main, 'remote', 'add', 'origin', `file://${remote}`);
  git(main, 'push', '-u', 'origin', 'main');

  const { runCli } = await import('../main');
  const { SQLiteStateStore, listGitWorktrees } = await import('@wtm/core');
  const initialized = await invoke(runCli, ['init', '--yes', '--json'], {
    cwd: main, initDatabasePath: databasePath, initUserDataDir: dataRoot,
    // Registering tells a running daemon to re-read its registrations; this fixture has none,
    // and must never reach the one on the machine running the suite.
    runtimeClient: { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never,
  });
  await writeFile(join(main, 'wtm.toml'), `${await readFile(join(main, 'wtm.toml'), 'utf8')}\n[tasks.dev]\nrun = ["node", "-e", 'console.log("dev")']\n`);
  git(main, 'add', 'wtm.toml');
  git(main, 'commit', '-m', 'configure WTM');
  git(main, 'push');

  git(main, 'worktree', 'add', '-b', 'feature', linked);
  const store = new SQLiteStateStore(databasePath);
  const repository = store.listRepositories()[0];
  if (repository === undefined) throw new Error('initialized repository missing');
  store.reconcileWorktrees(repository.id, await listGitWorktrees(main));
  const workspace = store.listWorkspaces()[0];
  const linkedRecord = store.listWorktrees(repository.id).find(({ path }) => path === linked);
  if (workspace === undefined || linkedRecord === undefined) throw new Error('raw worktree was not reconciled');
  const registered = { id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope };
  const source = {
    listRegisteredWorkspaces: async () => [registered],
    readStatus: async () => ({
      workspace: registered,
      identity: {
        repositoryId: repository.id, worktreeId: linkedRecord.id, numericId: linkedRecord.numericId,
        path: linkedRecord.path, branch: linkedRecord.branch, headOid: linkedRecord.headOid, isMain: false,
      },
      state: linkedRecord.state,
      endpoints: [], processes: [], resources: [],
    }),
    readDoctor: async () => { throw new Error('unused'); },
    readExplain: async () => { throw new Error('unused'); },
    readPlan: async () => { throw new Error('unused'); },
    readEnv: async () => { throw new Error('unused'); },
    readPorts: async () => { throw new Error('unused'); },
  };
  const status = await invoke(runCli, ['status', workspace.id, '--json'], { cwd: linked, dataSource: source });
  const resolved = await invoke(runCli, ['resolve', 'dev', '--json'], { cwd: linked });
  const analysisDependencies = { cwd: nested, analysisDatabasePath: databasePath };
  const analysis = await invoke(runCli, ['analyze', 'feature', '--json'], analysisDependencies);
  const relativeAnalysis = await invoke(runCli, ['analyze', '../../linked-feature', '--json'], analysisDependencies);
  const absoluteAnalysis = await invoke(runCli, ['analyze', linked, '--json'], analysisDependencies);
  const numericAnalysis = await invoke(runCli, ['analyze', String(linkedRecord.numericId), '--json'], analysisDependencies);
  const allAnalysis = await invoke(runCli, ['analyze', '--all', '--json'], analysisDependencies);
  const globalAnalysis = await invoke(runCli, ['analyze', '--global', '--json'], { ...analysisDependencies, cwd: root });
  const cleanupAnalysis = await invoke(runCli, ['analyze', '--cleanup-candidates', '--json'], analysisDependencies);
  const conflictingModes = await invoke(runCli, ['analyze', '--all', '--cleanup-candidates', '--json'], analysisDependencies);
  const missingSelector = await invoke(runCli, ['analyze', 'missing-branch', '--json'], analysisDependencies);
  const unavailableState = await invoke(runCli, ['analyze', String(linkedRecord.numericId), '--json'], {
    cwd: nested, analysisDatabasePath: join(root, 'missing', 'state.db'),
  });
  const gitDiscoveryFailure = await invoke(runCli, ['analyze', '--json'], { ...analysisDependencies, cwd: root });
  const unavailableRemoveState = await invoke(runCli, ['remove', String(linkedRecord.numericId), '--json'], {
    cwd: nested, analysisDatabasePath: join(root, 'missing', 'state.db'),
  });
  const removeGitDiscoveryFailure = await invoke(runCli, ['remove', 'feature', '--json'], {
    ...analysisDependencies, cwd: root,
  });
  await writeFile(join(linked, 'dirty.txt'), 'untracked\n');
  const blockedAnalysis = await invoke(runCli, ['analyze', '../../linked-feature', '--json'], analysisDependencies);
  const blocked = await invoke(runCli, ['remove', '../../linked-feature', '--json'], analysisDependencies);
  const blockedNumeric = await invoke(runCli, ['remove', String(linkedRecord.numericId), '--json'], analysisDependencies);
  const blockedBranch = await invoke(runCli, ['remove', 'feature', '--json'], analysisDependencies);
  const blockedAbsolute = await invoke(runCli, ['remove', linked, '--json'], analysisDependencies);
  await rm(join(linked, 'dirty.txt'));
  git(linked, 'push', '-u', 'origin', 'feature');
  const pushed = git(linked, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').trim() === 'origin/feature';
  const removed = await invoke(runCli, ['remove', '../../linked-feature', '--json'], analysisDependencies);
  store.close();

  process.stdout.write(JSON.stringify({
    initialized: initialized.code === 0 && initialized.envelope.ok === true,
    rawWorktreeDiscovered: linkedRecord.path === linked,
    statusOk: status.code === 0 && status.envelope.ok === true,
    resolvedTask: resolved.envelope.data.argv,
    analysisCompleted: analysis.envelope.data !== null && analysis.envelope.data.identity.path === linked,
    branchSelectorWorks: analysis.code === 0,
    relativeSelectorWorks: relativeAnalysis.code === 0 && relativeAnalysis.envelope.data.identity.path === linked,
    absoluteSelectorWorks: absoluteAnalysis.code === 0 && absoluteAnalysis.envelope.data.identity.path === linked,
    numericSelectorWorks: numericAnalysis.code === 0 && numericAnalysis.envelope.data.identity.path === linked,
    allModeWorks: allAnalysis.code === 0 && allAnalysis.envelope.data.analyses.length === 2,
    globalModeWorks: globalAnalysis.code === 0 && globalAnalysis.envelope.data.analyses.length === 2,
    cleanupCandidatesModeWorks: cleanupAnalysis.code === 0 && cleanupAnalysis.envelope.data.analyses.length === 1,
    conflictingModes: { code: conflictingModes.code, error: conflictingModes.envelope.errors[0].code },
    missingSelector: { code: missingSelector.code, error: missingSelector.envelope.errors[0].code },
    unavailableState: { code: unavailableState.code, error: unavailableState.envelope.errors[0].code },
    unavailableRemoveState: {
      code: unavailableRemoveState.code, error: unavailableRemoveState.envelope.errors[0].code,
    },
    gitDiscoveryFailure: {
      code: gitDiscoveryFailure.code,
      error: gitDiscoveryFailure.envelope.errors[0].code,
      command: gitDiscoveryFailure.envelope.errors[0].context?.command ?? null,
    },
    removeGitDiscoveryFailure: {
      code: removeGitDiscoveryFailure.code,
      error: removeGitDiscoveryFailure.envelope.errors[0].code,
      command: removeGitDiscoveryFailure.envelope.errors[0].context?.command ?? null,
    },
    nestedBlockedAnalysis: blockedAnalysis.envelope.data?.safety.blockers.map((item: { code: string }) => item.code)
      ?? blockedAnalysis.envelope.errors.map((item: { code: string }) => item.code),
    dirtyRemovalBlocked: blocked.envelope.errors[0].code,
    preservedRemoveSelectors: {
      numeric: blockedNumeric.envelope.errors[0].code,
      branch: blockedBranch.envelope.errors[0].code,
      absolute: blockedAbsolute.envelope.errors[0].code,
    },
    pushed,
    safelyRemoved: removed.code === 0 && !(await exists(linked)),
    // The field keeps its macOS name because the assertion that reads it lives in
    // `full-workflow.test.ts`; the directory it reports on is now whichever one this platform
    // installs user services into — `~/Library/LaunchAgents` or `~/.config/systemd/user`.
    serviceRootUntouched: (await readdir(serviceRoot)).length === 0,
    socketAbsent: !(await exists(socketPath)),
    remoteProtocol: 'file',
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}

function git(cwd: string, ...argv: string[]): string {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function invoke(runCli: typeof import('../main').runCli, argv: string[], dependencies: CliDependencies) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    ...dependencies,
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
  });
  if (stderr !== '') throw new Error(stderr);
  return { code, envelope: JSON.parse(stdout) };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
