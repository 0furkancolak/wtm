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
  const output = await runGit(repoPath, ['worktree', 'list', '--porcelain', '-z']);
  return parseGitWorktreePorcelain(output);
}

export async function readGitRepositoryIdentity(repoPath: string): Promise<GitRepositoryIdentity> {
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'];
  const output = await runGit(repoPath, args);
  const [commonGitDir, topLevel] = output.toString('utf8').trimEnd().split('\n');
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

export async function readGitRemoteOrigin(repoPath: string): Promise<string | null> {
  try {
    const output = await runGit(repoPath, ['config', '--get', 'remote.origin.url']);
    const value = output.toString('utf8').trim();
    return value.length === 0 ? null : value;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return null;
    throw error;
  }
}

function runGit(repoPath: string, args: readonly string[]): Promise<Buffer> {
  const argv = gitArgv(repoPath, args);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? 'git', argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      reject(new GitCommandError({ argv, exitCode: null, signal: null, stderr: error.message }));
    });
    child.once('close', (exitCode, signal) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout));
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
