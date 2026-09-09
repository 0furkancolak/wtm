import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listGitWorktrees, SQLiteStateStore } from '@wtm/core';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

/**
 * `analyze --cleanup-candidates` over a repository whose linked worktrees differ on the tiers the
 * ranking compares, so the returned order is evidence about the ranking rather than about the
 * order `git worktree list` happened to report.
 *
 * The worktree directories are named so that plain path order is the *reverse* of the expected
 * ranking: `a-blocked` sorts first and must rank last, `z-merged` sorts last and must rank first.
 * A ranking that collapsed to the path tie-break would produce the wrong answer here rather than
 * the right one by accident.
 */
const fixture = await createGitSafetyFixture();
try {
  const merged = join(fixture.root, 'z-merged');
  await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'feature/merged', merged]);
  await fixture.write(merged, 'merged.txt', 'merged work\n');
  await fixture.git(merged, ['add', 'merged.txt']);
  await fixture.git(merged, ['commit', '-m', 'Add merged work']);
  await fixture.git(merged, ['push', '-u', 'origin', 'feature/merged']);
  await fixture.git(fixture.repoPath, ['merge', '--no-ff', '-m', 'Merge feature/merged', 'feature/merged']);
  await fixture.git(fixture.repoPath, ['push', 'origin', 'main']);

  // An untracked file, which the safety analysis refuses to call deletable.
  const blocked = join(fixture.root, 'a-blocked');
  await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'feature/blocked', blocked]);
  await writeFile(join(blocked, 'scratch.txt'), 'uncommitted\n');

  const databasePath = join(fixture.root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  const workspace = store.upsertWorkspace({
    name: 'ranking',
    root: fixture.repoPath,
    scope: 'local',
    configPath: join(fixture.repoPath, 'wtm.toml'),
  });
  const repository = store.upsertRepository({
    workspaceId: workspace.id,
    commonGitDir: join(fixture.repoPath, '.git'),
    mainRoot: fixture.repoPath,
    remoteIdentity: null,
  });
  store.reconcileWorktrees(repository.id, await listGitWorktrees(fixture.repoPath));
  store.close();

  const registered = await analyze(fixture, databasePath, ['--json']);
  const human = await analyze(fixture, databasePath, []);
  // The same repository with no state database at all: `analyze` answers for repositories WTM has
  // never registered, and the ranking has to say which inputs it could not read rather than
  // scoring them as though the worktrees were idle.
  const unregistered = await analyze(fixture, join(fixture.root, 'never-created.db'), ['--json']);

  const analyses = envelopeAnalyses(registered.stdout);
  process.stdout.write(JSON.stringify({
    exitCode: registered.exitCode,
    order: analyses.map(({ identity }) => identity.path.slice(fixture.root.length + 1)),
    ranks: analyses.map(({ cleanup }) => cleanup.rank),
    scores: analyses.map(({ cleanup }) => cleanup.score),
    reasons: analyses.map(({ cleanup }) => cleanup.reason),
    readiness: analyses.map(({ safety }) => safety.readiness),
    mainWorktreeIncluded: analyses.some(({ identity }) => identity.isMain),
    humanExitCode: human.exitCode,
    humanOrder: analyses.map(({ identity }) => human.stdout.indexOf(identity.path)),
    unregisteredReasons: envelopeAnalyses(unregistered.stdout).map(({ cleanup }) => cleanup.reason),
  }));
} finally {
  await fixture.cleanup();
  await rm(join(fixture.root, 'never-created.db'), { force: true });
}

interface RankedAnalysis {
  identity: { path: string; isMain: boolean };
  safety: { readiness: string };
  cleanup: { rank: number; score: number; reason: string[] };
}

function envelopeAnalyses(stdout: string): RankedAnalysis[] {
  return (JSON.parse(stdout) as { data: { analyses: RankedAnalysis[] } }).data.analyses;
}

async function analyze(
  target: GitSafetyFixture,
  databasePath: string,
  argv: readonly string[],
): Promise<{ stdout: string; exitCode: number }> {
  let stdout = '';
  const exitCode = await runCli(['analyze', '--cleanup-candidates', ...argv], {
    cwd: target.repoPath,
    analysisDatabasePath: databasePath,
    removalGlobalConfigPath: join(target.root, 'missing-global.toml'),
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  return { stdout, exitCode };
}
