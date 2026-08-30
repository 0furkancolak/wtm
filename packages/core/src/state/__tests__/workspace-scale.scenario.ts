import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateDiagnosticDataSource, runCli } from '../../../../cli/src/index';
import { ReconcilerQueue } from '../../../../daemon/src/index';
import { listGitWorktrees } from '../../git/git-runner';
import { discoverWorkspace } from '../../workspace/discover';
import { SQLiteStateStore } from '../sqlite-store';

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-scale-')));
const store = new SQLiteStateStore(join(root, 'state.db'));
try {
  const workspace = store.upsertWorkspace({ name: 'scale', root, scope: 'local', configPath: join(root, 'wtm.toml') });
  const worktreeIds: string[] = [];
  for (let repositoryIndex = 0; repositoryIndex < 10; repositoryIndex += 1) {
    const mainRoot = join(root, `repo-${repositoryIndex}`);
    await mkdir(mainRoot, { recursive: true });
    git(mainRoot, 'init', '--initial-branch=main');
    git(mainRoot, 'config', 'user.name', 'WTM Scale');
    git(mainRoot, 'config', 'user.email', 'scale@example.invalid');
    await writeFile(join(mainRoot, 'README.md'), `repo ${repositoryIndex}\n`);
    git(mainRoot, 'add', 'README.md');
    git(mainRoot, 'commit', '-m', 'fixture');
    for (let worktreeIndex = 1; worktreeIndex < 10; worktreeIndex += 1) {
      git(mainRoot, 'worktree', 'add', '-b', `fixture-${repositoryIndex}-${worktreeIndex}`,
        join(root, 'worktrees', `${repositoryIndex}-${worktreeIndex}`));
    }
    const repository = store.upsertRepository({
      workspaceId: workspace.id,
      commonGitDir: join(mainRoot, '.git'),
      mainRoot,
      remoteIdentity: null,
    });
    worktreeIds.push(...store.reconcileWorktrees(repository.id, await listGitWorktrees(mainRoot)).discovered.map(({ id }) => id));
  }
  for (const [index, worktreeId] of worktreeIds.slice(0, 3).entries()) {
    store.createManagedProcess({
      worktreeId, taskName: `task-${index}`, pid: 90_000 + index, pgid: 90_000 + index,
      processStartTime: `fixture-${index}`, commandFingerprint: `fingerprint-${index}`, state: 'RUNNING',
      startedAt: new Date(0).toISOString(), stoppedAt: null,
      stdoutPath: join(root, 'logs', `${index}.out`), stderrPath: join(root, 'logs', `${index}.err`),
    });
  }

  const source = createStateDiagnosticDataSource(store, {
    cwd: root,
    globalConfigPath: join(root, 'config.toml'),
  });
  const globalSamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    globalSamples.push(await measure(async () => {
      let output = '';
      const exitCode = await runCli(['status', '--global', '--json'], {
        cwd: root, dataSource: source, stdout: (value: string) => { output += value; }, stderr: () => {},
      });
      if (exitCode !== 0 || JSON.parse(output).ok !== true) throw new Error('warm global status failed');
    }));
  }

  const firstRepository = store.listRepositories()[0];
  if (firstRepository === undefined) throw new Error('scale fixture has no repository');
  const reconciliationSamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const queue = new ReconcilerQueue({
      run: async () => {
        const discovery = await discoverWorkspace(firstRepository.mainRoot, { maxDepth: 0 });
        const repository = discovery.repositories[0];
        if (repository === undefined) throw new Error('single repository discovery failed');
        store.reconcileWorktrees(firstRepository.id, repository.worktrees);
      },
    });
    reconciliationSamples.push(await measure(async () => {
      queue.schedule({ root: firstRepository.mainRoot, kind: 'git-topology' });
      await queue.flush();
    }));
    await queue.close();
  }
  const warmGlobalStatusMs = percentile(globalSamples, 0.95);
  const reconciliationMs = percentile(reconciliationSamples, 0.95);
  process.stdout.write(JSON.stringify({
    fixture: {
      repositories: store.listRepositories().length,
      worktrees: store.listWorktrees().length,
      runningTasks: store.listManagedProcesses({ states: ['RUNNING'] }).length,
    },
    warmGlobalStatus: {
      path: 'runCli(status --global --json) -> StateDiagnosticDataSource',
      measuredMs: warmGlobalStatusMs, targetMs: 500, status: warmGlobalStatusMs < 500 ? 'pass' : 'blocker',
    },
    singleRepositoryReconciliation: {
      path: 'ReconcilerQueue -> discoverWorkspace/listGitWorktrees -> SQLiteStateStore.reconcileWorktrees',
      measuredMs: reconciliationMs, targetMs: 250, status: reconciliationMs < 250 ? 'pass' : 'blocker',
    },
  }));
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}

function git(cwd: string, ...argv: string[]): void {
  execFileSync('git', argv, { cwd, stdio: 'ignore' });
}

async function measure(operation: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? Number.POSITIVE_INFINITY;
}
