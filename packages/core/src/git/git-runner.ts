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
  timedOut?: boolean;
}

/**
 * Every command this module runs is local plumbing that finishes in milliseconds on a healthy
 * repository, so a git that is still going after this long is stuck rather than slow — waiting
 * on a lock, an unresponsive filesystem, or a macOS privacy prompt no background agent can
 * answer. Without a bound the caller waits forever: a single unreachable repository is enough
 * to hang daemon startup before the IPC socket is ever created, which reads to everyone
 * involved as a daemon that silently died.
 */
export const defaultGitTimeoutMs = 30_000;
/** How long a timed-out git is given to die politely before it is killed outright. */
const terminationGraceMs = 2_000;

/**
 * Listing worktrees is the daemon's health check for a repository: it runs for every
 * registered repository on every reconcile pass, and takes single-digit milliseconds on a
 * healthy one. It is bounded far more tightly than the general default so that a repository
 * nobody can read is written off quickly instead of holding the pass open.
 */
export const worktreeListTimeoutMs = 5_000;

/**
 * The one bound in this module that covers a command which talks to a network. `git fetch` on a
 * cold or large remote legitimately outlasts every local plumbing call by an order of magnitude,
 * so the general default would abort honest work; it is still bounded, because a fetch waiting on
 * an unreachable host or a credential prompt no background agent can answer must not hold the
 * caller open forever.
 */
export const remoteFetchTimeoutMs = 120_000;

export interface GitCommandOptions {
  acceptedExitCodes?: readonly number[];
  /** Overrides {@link defaultGitTimeoutMs} for a call known to need longer. */
  timeoutMs?: number;
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
  /** True when the command was killed for exceeding its timeout rather than failing on its own. */
  readonly timedOut: boolean;

  constructor(failure: GitCommandFailure) {
    const stderr = sanitizeGitDiagnostic(failure.stderr);
    const status = failure.exitCode === null
      ? `signal ${failure.signal ?? 'none'}`
      : `exit ${failure.exitCode}`;
    // Which git, and in which repository. Without them the daemon's log said only that "a" git
    // command timed out, twenty-two times a pass, naming neither the command nor the directory
    // — which is no more use than silence when one repository on a slow volume is the cause.
    super(`Git ${describeGitCommand(failure.argv)} failed (${status})${stderr.length === 0 ? '' : `: ${stderr}`}`);
    this.name = 'GitCommandError';
    this.argv = Object.freeze([...failure.argv]);
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.stderr = stderr;
    this.timedOut = failure.timedOut === true;
  }
}

/**
 * A second, wider bound for a repository that overran the first one. The tight default is
 * right for a pass over many repositories at once; it is the wrong verdict for a single cold
 * read, and the difference between the two is what separates a slow disk from an unreadable
 * one. Still bounded, because a repository that cannot be read must not hold a pass open.
 */
export const retriedWorktreeListTimeoutMs = 20_000;

export async function listGitWorktrees(
  repoPath: string,
  timeoutMs: number = worktreeListTimeoutMs,
): Promise<GitWorktreeRecord[]> {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain', '-z'], { timeoutMs });
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
  const timeoutMs = options.timeoutMs ?? defaultGitTimeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? 'git', argv.slice(1), {
      env: createGitEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A process blocked in an uninterruptible open() ignores SIGTERM, so the escalation is
      // what actually frees the caller.
      killTimer = setTimeout(() => child.kill('SIGKILL'), terminationGraceMs);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimers();
      reject(new GitCommandError({ argv, exitCode: null, signal: null, stderr: error.message }));
    });
    child.once('close', (exitCode, signal) => {
      clearTimers();
      if (timedOut) {
        reject(new GitCommandError({
          argv,
          exitCode: null,
          signal,
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        }));
        return;
      }
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

/** `worktree list in /projects/demo/api` — the subcommand and the directory it ran in. */
function describeGitCommand(argv: readonly string[]): string {
  const repositoryIndex = argv.indexOf('-C');
  const repository = repositoryIndex === -1 ? undefined : argv[repositoryIndex + 1];
  const words = argv
    .slice(1)
    .filter((word, index) => index !== repositoryIndex - 1 && index !== repositoryIndex)
    .filter((word) => !word.startsWith('-'))
    .slice(0, 2);
  const command = words.length === 0 ? 'command' : words.join(' ');
  return repository === undefined ? command : `${command} in ${repository}`;
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
