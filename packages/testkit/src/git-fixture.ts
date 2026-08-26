import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gitRepositoryRoutingVariables = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
] as const;

export interface GitWorktreeFixture {
  repoPath: string;
  linkedWorktreePath: string;
  detachedWorktreePath: string;
  head: string;
  cleanup(): Promise<void>;
}

export interface GitSafetyFixture {
  root: string;
  repoPath: string;
  linkedWorktreePath: string;
  remotePath: string;
  mainHead: string;
  featureHead: string;
  git(repoPath: string, args: readonly string[], expectedExitCodes?: readonly number[]): Promise<GitResult>;
  write(repoPath: string, relativePath: string, contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function createGitWorktreeFixture(): Promise<GitWorktreeFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-git-fixture-'));
  const repoPath = join(directory, 'repo with spaces;still-a-path');
  const linkedWorktreePath = join(directory, 'linked');
  const detachedWorktreePath = join(directory, 'detached');
  const cleanup = () => rm(directory, { recursive: true, force: true });

  try {
    await execFileAsync('git', ['init', '--initial-branch=main', repoPath], { env: isolatedGitEnvironment() });
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

export async function createGitSafetyFixture(): Promise<GitSafetyFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'wtm-git-safety-'));
  const remotePath = join(directory, 'remote.git');
  const repoPath = join(directory, 'main repo');
  const linkedWorktreePath = join(directory, 'linked feature');
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });

  try {
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remotePath], {
      env: isolatedGitEnvironment(),
    });
    await execFileAsync('git', ['init', '--initial-branch=main', repoPath], { env: isolatedGitEnvironment() });
    await git(repoPath, ['config', 'user.name', 'WTM Test']);
    await git(repoPath, ['config', 'user.email', 'wtm-test@example.invalid']);
    await writeFile(join(repoPath, 'README.md'), 'main fixture\n');
    await git(repoPath, ['add', 'README.md']);
    await git(repoPath, ['commit', '-m', 'Initialize safety fixture']);
    await git(repoPath, ['remote', 'add', 'origin', remotePath]);
    await git(repoPath, ['push', '-u', 'origin', 'main']);
    const mainHead = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();

    await git(repoPath, ['worktree', 'add', '-b', 'feature/safe', linkedWorktreePath]);
    await writeFile(join(linkedWorktreePath, 'feature.txt'), 'safe feature\n');
    await git(linkedWorktreePath, ['add', 'feature.txt']);
    await git(linkedWorktreePath, ['commit', '-m', 'Add safe feature']);
    await git(linkedWorktreePath, ['push', '-u', 'origin', 'feature/safe']);
    const featureHead = (await git(linkedWorktreePath, ['rev-parse', 'HEAD'])).stdout.trim();

    const root = await realpath(directory);
    const canonicalRepoPath = await realpath(repoPath);
    const canonicalLinkedPath = await realpath(linkedWorktreePath);
    const canonicalRemotePath = await realpath(remotePath);

    return {
      root,
      repoPath: canonicalRepoPath,
      linkedWorktreePath: canonicalLinkedPath,
      remotePath: canonicalRemotePath,
      mainHead,
      featureHead,
      git: runFixtureGit,
      async write(targetRepoPath, relativePath, contents) {
        const target = join(targetRepoPath, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function runFixtureGit(
  repoPath: string,
  args: readonly string[],
  expectedExitCodes: readonly number[] = [0],
): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', ['-C', repoPath, ...args], { env: isolatedGitEnvironment() });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (!isExecFileError(error) || !expectedExitCodes.includes(error.code)) throw error;
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

function isExecFileError(error: unknown): error is Error & { code: number; stdout: string; stderr: string } {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'number'
    && 'stdout' in error
    && typeof error.stdout === 'string'
    && 'stderr' in error
    && typeof error.stderr === 'string';
}

function git(repoPath: string, args: string[]) {
  return execFileAsync('git', ['-C', repoPath, ...args], { env: isolatedGitEnvironment() });
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of gitRepositoryRoutingVariables) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  return environment;
}
