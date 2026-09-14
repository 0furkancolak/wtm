import { basename, resolve } from 'node:path';
import type { WtmError } from '@wtm/protocol';
import { resolveRepoScope } from '../config/repos';
import type { WtmConfig } from '../config/schema';
import { runGit } from '../git/git-runner';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type { RepositoryRecord } from '../state/store';
import { planWorktreeCreation, type WorktreeCreationPlan } from './create-worktree';

export type FeatureMemberResolution =
  | { outcome: 'resolved'; repositories: RepositoryRecord[] }
  | { outcome: 'refused'; error: WtmError };

/** The name `--repos` and `--repo` accept for each repository, by id. */
export function nameRepositories(input: {
  config: WtmConfig;
  workspaceRoot: string;
  repositories: readonly RepositoryRecord[];
}): Map<string, string> {
  return new Map(namedRepositories(input).map((entry) => [entry.repository.id, entry.scopeName ?? entry.directory]));
}

function namedRepositories(input: { config: WtmConfig; workspaceRoot: string; repositories: readonly RepositoryRecord[] }) {
  return input.repositories.map((repository) => ({
    repository,
    scopeName: resolveRepoScope(input.config, { workspaceRoot: input.workspaceRoot, repoRoot: repository.mainRoot })?.name ?? null,
    directory: basename(resolve(repository.mainRoot)),
  }));
}

/**
 * The repositories `--repos` names, in ascending id order, which is also the lease order.
 *
 * A `[repos.<name>]` entry names its repository; a repository with no entry answers to its main
 * root's directory name. A repository an entry names is not also reachable by its directory name,
 * so one repository never has two spellings.
 */
export function resolveFeatureMembers(input: {
  config: WtmConfig;
  workspaceRoot: string;
  repositories: readonly RepositoryRecord[];
  names: readonly string[];
  option?: '--repos' | '--repo';
}): FeatureMemberResolution {
  const option = input.option ?? '--repos';
  const names = [...new Set(input.names.map((name) => name.trim()).filter((name) => name.length > 0))];
  const named = namedRepositories(input);
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const chosen = new Map<string, RepositoryRecord>();
  for (const name of names) {
    const byEntry = named.filter((entry) => entry.scopeName === name);
    const matches = byEntry.length > 0
      ? byEntry
      : named.filter((entry) => entry.scopeName === null && entry.directory === name);
    if (matches.length === 0) unknown.push(name);
    else if (matches.length > 1) ambiguous.push(name);
    else chosen.set(matches[0]!.repository.id, matches[0]!.repository);
  }
  if (names.length === 0 || unknown.length > 0 || ambiguous.length > 0) {
    const reasons = [
      ...(names.length === 0 ? [`${option} names no repository.`] : []),
      ...(unknown.length > 0 ? [`${option} names no repository of this workspace: ${unknown.join(', ')}.`] : []),
      ...(ambiguous.length > 0 ? [`${option} names more than one repository: ${ambiguous.join(', ')}.`] : []),
    ];
    return {
      outcome: 'refused',
      error: {
        code: 'WTM_CONFIG_INVALID',
        message: reasons.join(' '),
        severity: 'error',
        context: { unknown, ambiguous, known: named.map((entry) => entry.scopeName ?? entry.directory).sort() },
      },
    };
  }
  return { outcome: 'resolved', repositories: [...chosen.values()].sort((left, right) => compare(left.id, right.id)) };
}

export interface FeatureMemberMeasurement {
  repository: RepositoryRecord;
  topology: readonly GitWorktreeRecord[];
  /** `refs/heads/<branch>`'s commit, or null when the branch does not exist. */
  branchOid: string | null;
  /** The commit `--from` names in this repository, or null when not given or unresolvable. */
  fromOid: string | null;
}

export interface FeatureMemberPlan {
  repository: RepositoryRecord;
  /** Index in the measured order, which is the lease order. */
  position: number;
  /** For a new branch, `startPoint` is the pinned OID rather than the ref that named it. */
  plan: WorktreeCreationPlan;
  startOid: string;
  branchExisted: boolean;
}

export type FeatureCreationDecision =
  | { outcome: 'plan'; members: FeatureMemberPlan[] }
  | { outcome: 'refused'; errors: WtmError[] };

/**
 * What a multi-repository create would do in every member, or every reason it will not.
 *
 * Pure, like `planWorktreeCreation`, which it runs once per member. Start points are pinned to
 * commit OIDs here, because the same branch name in two repositories is not the same commit and a
 * ref resolved later could have moved.
 */
export function planFeatureCreation(input: {
  workspaceRoot: string;
  branch: string;
  from?: string | undefined;
  members: readonly FeatureMemberMeasurement[];
  pathExists: (path: string) => boolean;
}): FeatureCreationDecision {
  const errors: WtmError[] = [];
  const members: FeatureMemberPlan[] = [];
  input.members.forEach((measurement, position) => {
    const repositoryContext = { repositoryId: measurement.repository.id, repository: measurement.repository.mainRoot };
    const decision = planWorktreeCreation({
      workspaceRoot: input.workspaceRoot,
      mainRoot: measurement.repository.mainRoot,
      branch: input.branch,
      topology: measurement.topology,
      branchExists: measurement.branchOid !== null,
      pathExists: input.pathExists,
      ...(input.from === undefined ? {} : { from: input.from }),
    });
    if (decision.outcome === 'refused') {
      errors.push({ ...decision.error, context: { ...(decision.error.context ?? {}), ...repositoryContext } });
      return;
    }
    const branchExisted = measurement.branchOid !== null;
    const startOid = branchExisted
      ? measurement.branchOid
      : input.from !== undefined ? measurement.fromOid : measurement.topology[0]?.head ?? null;
    if (startOid === null) {
      errors.push({
        code: 'WTM_CONFIG_INVALID',
        message: input.from !== undefined
          ? `--from ${input.from} does not name a commit in ${measurement.repository.mainRoot}.`
          : `${measurement.repository.mainRoot} has no main worktree HEAD to start ${decision.plan.branch} at.`,
        severity: 'error',
        context: { ...repositoryContext, ...(input.from === undefined ? {} : { from: input.from }) },
      });
      return;
    }
    members.push({
      repository: measurement.repository,
      position,
      startOid,
      branchExisted,
      plan: branchExisted ? decision.plan : { ...decision.plan, startPoint: startOid },
    });
  });
  return errors.length > 0 ? { outcome: 'refused', errors } : { outcome: 'plan', members };
}

/**
 * The commit `ref` names in `repoPath`, or null when it names none.
 *
 * `--end-of-options` keeps a ref that starts with `-` from being read as an option.
 */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  const result = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    acceptedExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
