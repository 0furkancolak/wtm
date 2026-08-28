import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-e2e-')));
const home = join(root, 'home');
const launchAgents = join(home, 'Library', 'LaunchAgents');
const dataRoot = join(home, 'Library', 'Application Support', 'WTM');
const databasePath = join(dataRoot, 'state.db');
const socketPath = join(dataRoot, 'wtmd.sock');
const gitConfig = join(root, 'gitconfig');
const remote = join(root, 'remote.git');
const main = join(root, 'workspace', 'repo');
const nested = join(main, 'src');
const linked = join(root, 'linked-feature');
await mkdir(launchAgents, { recursive: true, mode: 0o700 });
await mkdir(main, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '');
process.env.HOME = home;
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
  const initialized = await invoke(runCli, ['init', '--yes', '--no-ai-skill', '--json'], {
    cwd: main, initDatabasePath: databasePath, initUserDataDir: dataRoot,
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
    launchAgentsUntouched: (await readdir(launchAgents)).length === 0,
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
