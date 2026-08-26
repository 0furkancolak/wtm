import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitWorktreeFixture {
  repoPath: string;
  linkedWorktreePath: string;
  detachedWorktreePath: string;
  head: string;
  cleanup(): Promise<void>;
}

export async function createGitWorktreeFixture(): Promise<GitWorktreeFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-git-fixture-'));
  const repoPath = join(directory, 'repo with spaces;still-a-path');
  const linkedWorktreePath = join(directory, 'linked');
  const detachedWorktreePath = join(directory, 'detached');
  const cleanup = () => rm(directory, { recursive: true, force: true });

  try {
    await execFileAsync('git', ['init', '--initial-branch=main', repoPath]);
    await git(repoPath, ['config', 'user.name', 'WTM Test']);
    await git(repoPath, ['config', 'user.email', 'wtm-test@example.invalid']);
    await writeFile(join(repoPath, 'README.md'), 'fixture\n');
    await git(repoPath, ['add', 'README.md']);
    await git(repoPath, ['commit', '-m', 'Initial fixture commit']);

    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(repoPath, ['worktree', 'add', '-b', 'feature/linked', linkedWorktreePath]);
    await git(repoPath, ['worktree', 'add', '--detach', detachedWorktreePath, 'HEAD']);
    await git(repoPath, ['worktree', 'lock', '--reason', 'integration lock', linkedWorktreePath]);

    return {
      repoPath: await realpath(repoPath),
      linkedWorktreePath: await realpath(linkedWorktreePath),
      detachedWorktreePath: await realpath(detachedWorktreePath),
      head,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function git(repoPath: string, args: string[]) {
  return execFileAsync('git', ['-C', repoPath, ...args]);
}
