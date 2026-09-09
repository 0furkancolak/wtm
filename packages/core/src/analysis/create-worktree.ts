import { join, resolve } from 'node:path';
import type { WtmError } from '@wtm/protocol';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import { GitCommandError, listGitWorktrees, runGit } from '../git/git-runner';

/** Everything `planWorktreeCreation` needs, measured by the caller rather than read here. */
export interface WorktreeCreationInput {
  /** The workspace root the computed path is relative to. Only the registry knows this. */
  workspaceRoot: string;
  /** The repository's main working tree, whose directory name prefixes the new one. */
  mainRoot: string;
  branch: string;
  /** Every worktree Git currently reports for this repository. */
  topology: readonly GitWorktreeRecord[];
  /** Whether `refs/heads/<branch>` already exists. */
  branchExists: boolean;
  /** Whether anything already sits at the computed path. */
  pathExists: (path: string) => boolean;
  /** `--from`, the ref a *new* branch starts at. */
  from?: string | undefined;
}

export interface WorktreeCreationPlan {
  /** Where the worktree will be created. */
  path: string;
  /** The fully qualified branch ref the worktree will be on. */
  branchRef: string;
  branch: string;
  /** True when the branch is created by this operation rather than checked out. */
  createsBranch: boolean;
  /**
   * The commit the branch starts at, when it is created.
   *
   * Null when the branch already exists, because there is nothing to start. Otherwise `--from`
   * if given, and the main worktree's HEAD if not — never the caller's own HEAD, which is what
   * makes the same command produce the same branch point from any directory in the workspace.
   */
  startPoint: string | null;
}

export type WorktreeCreationDecision =
  | { outcome: 'plan'; plan: WorktreeCreationPlan }
  | { outcome: 'refused'; error: WtmError };

/**
 * The directory one worktree of `<repository>` gets for `<branch>`.
 *
 * Every character a branch may carry but a directory should not becomes `-`, runs collapse, and
 * leading and trailing separators are trimmed. Two branches can legitimately produce the same
 * name (`feat/auth` and `feat-auth`); that collision is left to the occupied-path refusal rather
 * than resolved with a generated suffix, because a computed path is only useful while a person
 * can guess it.
 */
export function worktreeDirectoryName(repositoryDirectory: string, branch: string): string | null {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  return slug.length === 0 ? null : `${repositoryDirectory}-${slug}`;
}

/**
 * What `wtm create` would do, or the first reason it will not.
 *
 * Pure: the caller measures the repository and hands the answers in, the same shape the lease
 * protocol uses for process liveness. Refusal order is fixed and tested, so an invocation that
 * is wrong in two ways reports the same one every time.
 */
export function planWorktreeCreation(input: WorktreeCreationInput): WorktreeCreationDecision {
  const branch = input.branch.startsWith('refs/heads/')
    ? input.branch.slice('refs/heads/'.length)
    : input.branch;
  const branchRef = `refs/heads/${branch}`;

  if (input.from !== undefined && input.branchExists) {
    return refused('WTM_CONFIG_INVALID',
      `--from cannot be combined with ${branch}, which already exists: `
      + 'starting a new branch somewhere and checking out an existing one are different requests.',
      { branch, from: input.from });
  }

  const holder = input.topology.find((record) => record.branch === branchRef);
  if (holder !== undefined) {
    return refused('GIT_BRANCH_IN_USE',
      `${branch} is already checked out in ${holder.path}. `
      + 'A branch can only be checked out in one worktree at a time.',
      { branch, worktreePath: holder.path });
  }

  const directory = worktreeDirectoryName(basenameOf(input.mainRoot), branch);
  if (directory === null) {
    return refused('WTM_CONFIG_INVALID',
      `${branch} has no characters a directory name can be built from.`, { branch });
  }
  const path = join(resolve(input.workspaceRoot), directory);
  if (input.pathExists(path)) {
    return refused('WTM_WORKTREE_PATH_OCCUPIED',
      `${path} already exists, so the worktree for ${branch} cannot be created there. `
      + 'Move or remove it, or name the branch differently.',
      { branch, path });
  }

  return {
    outcome: 'plan',
    plan: {
      path,
      branch,
      branchRef,
      createsBranch: !input.branchExists,
      startPoint: input.branchExists ? null : input.from ?? mainWorktreeHead(input.topology),
    },
  };
}

/**
 * Whether `refs/heads/<branch>` exists in this repository.
 *
 * `show-ref --verify` answers with its exit status, so exit 1 is the answer "no" rather than a
 * failure: it is accepted here and anything else is left to raise.
 */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const ref = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
  const result = await runGit(repoPath, ['show-ref', '--verify', '--quiet', '--', ref], {
    acceptedExitCodes: [0, 1],
  });
  return result.exitCode === 0;
}

/**
 * Creates the worktree the plan describes, and reports what Git actually produced.
 *
 * The result is read back from `git worktree list` rather than assumed from the plan: the point
 * of the read is to report the path, branch and commit Git settled on, not the ones asked for.
 */
export async function createWorktree(
  repoPath: string,
  plan: WorktreeCreationPlan,
): Promise<GitWorktreeRecord> {
  await runGit(repoPath, ['check-ref-format', '--branch', plan.branch]);
  const argv = plan.createsBranch
    ? ['worktree', 'add', '-b', plan.branch, '--', plan.path, plan.startPoint ?? 'HEAD']
    : ['worktree', 'add', '--', plan.path, plan.branch];
  await runGit(repoPath, argv);
  const created = (await listGitWorktrees(repoPath))
    .find((record) => resolve(record.path) === resolve(plan.path));
  if (created === undefined) {
    throw new GitCommandError({
      argv,
      exitCode: 0,
      signal: null,
      stderr: `git worktree add reported success but ${plan.path} is not in the topology`,
    });
  }
  return created;
}

/** The main worktree is the first record Git reports, and its HEAD is the default start point. */
function mainWorktreeHead(topology: readonly GitWorktreeRecord[]): string {
  return topology[0]?.head ?? 'HEAD';
}

/** `node:path`'s basename, without importing it for one call that must also accept a trailing sep. */
function basenameOf(path: string): string {
  const normalized = resolve(path);
  const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? normalized;
}

function refused(
  code: 'WTM_CONFIG_INVALID' | 'GIT_BRANCH_IN_USE' | 'WTM_WORKTREE_PATH_OCCUPIED',
  message: string,
  context: Record<string, unknown>,
): WorktreeCreationDecision {
  return { outcome: 'refused', error: { code, message, severity: 'error', context } };
}
