import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkspaceFixture {
  root: string;
  firstRepoPath: string;
  secondRepoPath: string;
  linkedWorktreePath: string;
  nestedRepoPath: string | null;
  userDataDir: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceFixtureOptions {
  includeNestedRepository?: boolean;
}

export async function createWorkspaceFixture(options: WorkspaceFixtureOptions = {}): Promise<WorkspaceFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-workspace-fixture-'));
  const root = join(directory, 'workspace with spaces');
  const firstRepoPath = join(root, 'services', 'first repo');
  const secondRepoPath = join(root, 'tools', 'second-repo');
  const linkedWorktreePath = join(root, 'linked first worktree');
  const nestedRepoPath = options.includeNestedRepository === true
    ? join(firstRepoPath, 'examples', 'nested-repo')
    : null;
  const userDataDir = join(directory, 'user-data');
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });

  try {
    await mkdir(root, { recursive: true });
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'Makefile'), 'dev:\n\t@echo workspace-dev\n');
    await createRepository(firstRepoPath, 'first');
    await createRepository(secondRepoPath, 'second');
    await git(firstRepoPath, ['worktree', 'add', '-b', 'feature/existing', linkedWorktreePath]);
    if (nestedRepoPath !== null) {
      await createRepository(nestedRepoPath, 'nested');
      await writeFile(join(nestedRepoPath, 'package.json'), '{"scripts":{"dev":"node server.js"}}\n');
    }

    return {
      root: await realpath(root),
      firstRepoPath: await realpath(firstRepoPath),
      secondRepoPath: await realpath(secondRepoPath),
      linkedWorktreePath: await realpath(linkedWorktreePath),
      nestedRepoPath: nestedRepoPath === null ? null : await realpath(nestedRepoPath),
      userDataDir: await realpath(userDataDir),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function createRepository(path: string, label: string): Promise<void> {
  await execFileAsync('git', ['init', '--initial-branch=main', path]);
  await git(path, ['config', 'user.name', 'WTM Test']);
  await git(path, ['config', 'user.email', 'wtm-test@example.invalid']);
  await writeFile(join(path, 'README.md'), `${label} fixture\n`);
  await git(path, ['add', 'README.md']);
  await git(path, ['commit', '-m', `Initialize ${label} fixture`]);
}

function git(repoPath: string, args: string[]) {
  return execFileAsync('git', ['-C', repoPath, ...args]);
}
