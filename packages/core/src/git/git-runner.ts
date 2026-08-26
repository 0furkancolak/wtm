import { spawn } from 'node:child_process';
import { parseGitWorktreePorcelain } from './worktree-parser';
import type { GitWorktreeRecord } from './worktree-parser';

export interface GitRepositoryIdentity {
  commonGitDir: string;
  topLevel: string;
}

interface GitCommandFailure {
  argv: readonly string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface GitCommandOptions {
  acceptedExitCodes?: readonly number[];
}

export interface GitCommandResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

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

export class GitCommandError extends Error {
  readonly code = 'GIT_COMMAND_FAILED' as const;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(failure: GitCommandFailure) {
    const stderr = sanitizeGitDiagnostic(failure.stderr);
    const status = failure.exitCode === null
      ? `signal ${failure.signal ?? 'none'}`
      : `exit ${failure.exitCode}`;
    super(`Git command failed (${status})${stderr.length === 0 ? '' : `: ${stderr}`}`);
    this.name = 'GitCommandError';
    this.argv = Object.freeze([...failure.argv]);
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.stderr = stderr;
  }
}

export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeRecord[]> {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain', '-z']);
  return parseGitWorktreePorcelain(result.stdout);
}

export async function readGitRepositoryIdentity(repoPath: string): Promise<GitRepositoryIdentity> {
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'];
  const result = await runGit(repoPath, args);
  const [commonGitDir, topLevel] = result.stdout.toString('utf8').trimEnd().split('\n');
  if (commonGitDir === undefined || topLevel === undefined) {
    throw new GitCommandError({
      argv: gitArgv(repoPath, args),
      exitCode: 0,
      signal: null,
      stderr: 'git rev-parse returned incomplete repository identity',
    });
  }
  return { commonGitDir, topLevel };
}

export async function readGitCommonDirectory(repoPath: string): Promise<string> {
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const result = await runGit(repoPath, args);
  const output = result.stdout.toString('utf8').trimEnd();
  if (output.length === 0 || output.includes('\n') || output.includes('\0')) {
    throw new GitCommandError({
      argv: gitArgv(repoPath, args),
      exitCode: 0,
      signal: null,
      stderr: 'git rev-parse returned an invalid common Git directory',
    });
  }
  return output;
}

export async function readGitRemoteOrigin(repoPath: string): Promise<string | null> {
  try {
    const result = await runGit(repoPath, ['config', '--get', 'remote.origin.url']);
    const value = result.stdout.toString('utf8').trim();
    return value.length === 0 ? null : value;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return null;
    throw error;
  }
}

export function runGit(
  repoPath: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const argv = gitArgv(repoPath, args);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? 'git', argv.slice(1), {
      env: createGitEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      reject(new GitCommandError({ argv, exitCode: null, signal: null, stderr: error.message }));
    });
    child.once('close', (exitCode, signal) => {
      const acceptedExitCodes = options.acceptedExitCodes ?? [0];
      if (exitCode !== null && acceptedExitCodes.includes(exitCode)) {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: sanitizeGitDiagnostic(Buffer.concat(stderr).toString('utf8')),
          exitCode,
        });
        return;
      }
      reject(new GitCommandError({
        argv,
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
  });
}

export function createGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of gitRepositoryRoutingVariables) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) delete environment[key];
  }
  return environment;
}

function gitArgv(repoPath: string, args: readonly string[]): readonly string[] {
  return ['git', '-C', repoPath, ...args];
}

function sanitizeGitDiagnostic(value: string): string {
  return value
    .replaceAll('\0', '')
    .trim()
    .slice(0, 4096)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu, '$1***@')
    .replace(/\b(token|password|passwd|secret|authorization)=([^&\s]+)/giu, '$1=***');
}

export type { GitWorktreeRecord } from './worktree-parser';
