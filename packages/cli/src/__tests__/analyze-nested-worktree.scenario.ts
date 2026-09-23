import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { isolatedGitEnvironment } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';

/**
 * Regression test for a bug fixed alongside this file: plain `wtm analyze` (no selector, no
 * aggregate mode) silently analyzed the *main* worktree when run from inside a linked one, as
 * soon as the linked worktree's own path was a child of the main worktree's path — which
 * `docs/04-cli-reference.md`'s own documented `wtm create` formula
 * (`<workspace-root>/<repository-directory>-<branch-slug>`) produces by default, whenever a
 * workspace's root is the repository itself (the single-repo case, by far the most common one).
 *
 * `main.ts`'s no-selector fast path resolved with a plain `topology.find(({ path }) =>
 * containsPath(path, cwd))`: since the main worktree's path is a filesystem *ancestor* of the
 * nested linked worktree, `containsPath` was also true for it, and `git worktree list`'s own
 * order put the main worktree first — so `.find` always stopped there, before ever reaching the
 * more specific (and correct) match later in the list. `worktree-selector.ts` already solves the
 * identical ambiguity for every other selector-driven command by keeping every containing
 * candidate and sorting on path length; this scenario exercises `analyze`'s own separate fast
 * path with exactly the layout that used to break it.
 */
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: await isolatedGitEnvironment() });
}

const root = await mkdtemp(join(tmpdir(), 'wtm-analyze-nested-'));
try {
  const repoPath = join(root, 'repo-a');
  await execFileAsync('git', ['init', '--initial-branch=main', repoPath], { env: await isolatedGitEnvironment() });
  await git(repoPath, ['config', 'user.name', 'WTM Test']);
  await git(repoPath, ['config', 'user.email', 'wtm-test@example.invalid']);
  await writeFile(join(repoPath, 'README.md'), 'fixture\n');
  await git(repoPath, ['add', 'README.md']);
  await git(repoPath, ['commit', '-m', 'Initial fixture commit']);

  // Exactly `docs/04-cli-reference.md`'s documented `wtm create` path formula:
  // `<workspace-root>/<repository-directory>-<branch-slug>`, with the workspace root being the
  // repository itself — nested inside the main worktree's own directory tree.
  const nestedWorktreePath = join(repoPath, `${basename(repoPath)}-feature-x`);
  await git(repoPath, ['worktree', 'add', '-b', 'feature-x', nestedWorktreePath]);

  let stdout = '';
  const exitCode = await runCli(['analyze', '--json'], {
    cwd: await realpath(nestedWorktreePath),
    analysisDatabasePath: join(root, 'absent.db'),
    removalGlobalConfigPath: join(root, 'absent-global.toml'),
    stdout: (value) => { stdout += value; },
    stderr: () => {},
  });
  const envelope = JSON.parse(stdout);
  process.stdout.write(`${JSON.stringify({
    exitCode,
    ok: envelope.ok,
    resolvedPath: envelope.data?.identity?.path ?? null,
    resolvedIsMain: envelope.data?.identity?.isMain ?? null,
    expectedPath: await realpath(nestedWorktreePath),
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}
