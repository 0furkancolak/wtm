import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

/**
 * Counts `git fetch` invocations out of process, through a `git` earlier on `PATH` that appends
 * one line per fetch to a log and delegates everything else to the real one. The number the
 * aggregate modes must produce is one per *repository*: an implementation that refreshed inside
 * the per-worktree analysis would still pass every assertion about freshness while sending three
 * times the traffic, and only a count can tell the two apart.
 */
const repositoryCount = 3;
const worktreesPerRepository = 3;

const root = await mkdtemp(join(tmpdir(), 'wtm-refresh-remotes-'));
const fixtures: GitSafetyFixture[] = [];
try {
  for (let index = 0; index < repositoryCount; index += 1) {
    const fixture = await createGitSafetyFixture();
    fixtures.push(fixture);
    // The fixture ships a main worktree and one linked worktree; the third makes the
    // per-worktree count differ from the per-repository count by more than one.
    const extra = join(fixture.root, 'second feature');
    await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'feature/second', extra]);
    await fixture.git(extra, ['push', '-u', 'origin', 'feature/second']);
  }

  const databasePath = join(root, 'state.db');
  const store = new SQLiteStateStore(databasePath);
  for (const [index, fixture] of fixtures.entries()) {
    const workspace = store.upsertWorkspace({
      name: `refresh-${index}`,
      root: fixture.repoPath,
      scope: 'local',
      configPath: join(fixture.repoPath, 'wtm.toml'),
    });
    store.upsertRepository({
      workspaceId: workspace.id,
      commonGitDir: join(fixture.repoPath, '.git'),
      mainRoot: fixture.repoPath,
      remoteIdentity: null,
    });
  }
  store.close();

  const fetchLog = join(root, 'fetches.log');
  await installFetchCountingGit(join(root, 'fake-bin'), fetchLog);

  const globalRun = await capture(['analyze', '--global', '--refresh-remotes', '--json'], root, databasePath);
  const globalFetches = await countFetches(fetchLog);
  const allRun = await capture(
    ['analyze', '--all', '--refresh-remotes', '--json'],
    fixtures[0]?.repoPath ?? root,
    databasePath,
  );
  const allFetches = await countFetches(fetchLog) - globalFetches;

  process.stdout.write(`${JSON.stringify({
    repositories: repositoryCount,
    worktreesPerRepository,
    globalOk: globalRun.ok,
    globalAnalyses: globalRun.analyses,
    globalFetches,
    allOk: allRun.ok,
    allAnalyses: allRun.analyses,
    allFetches,
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
  for (const fixture of fixtures) await fixture.cleanup();
}

async function capture(argv: readonly string[], cwd: string, databasePath: string) {
  let stdout = '';
  await runCli(argv, {
    cwd,
    analysisDatabasePath: databasePath,
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    data: { analyses?: unknown[] } | null;
    errors: Array<{ code: string; message: string }>;
  };
  if (!envelope.ok) process.stderr.write(`${JSON.stringify(envelope.errors)}\n`);
  return { ok: envelope.ok, analyses: envelope.data?.analyses?.length ?? null };
}

async function installFetchCountingGit(directory: string, logPath: string): Promise<void> {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await mkdir(directory, { recursive: true });
  const shim = join(directory, 'git');
  await writeFile(shim, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('fetch')) appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
process.stdout.write(result.stdout ?? Buffer.alloc(0));
process.stderr.write(result.stderr ?? Buffer.alloc(0));
process.exit(result.status ?? 1);
`, { flag: 'wx' });
  await chmod(shim, 0o755);
  process.env.PATH = `${directory}${delimiter}${process.env.PATH ?? ''}`;
}

async function countFetches(logPath: string): Promise<number> {
  try {
    return (await readFile(logPath, 'utf8')).split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}
