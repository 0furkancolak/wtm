import { resolve } from 'node:path';
import type { Remediation, WtmError } from '@wtm/protocol';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type { FeatureCreationMemberRecord } from '../state/store';
import type { WorktreeCreationPlan } from './create-worktree';

export type MemberRecoveryAction =
  | { action: 'skip' }
  | { action: 'mark-applied'; worktree: GitWorktreeRecord }
  | { action: 'apply'; plan: WorktreeCreationPlan }
  | { action: 'refuse'; error: WtmError };

export interface MemberRecoveryInput {
  member: FeatureCreationMemberRecord;
  /** The short branch name, e.g. `feat/auth`. */
  branch: string;
  repositoryRegistered: boolean;
  topology: readonly GitWorktreeRecord[];
  branchOid: string | null;
  pathExists: boolean;
}

/**
 * What `--resume` does with one journalled member (spec §4).
 *
 * The recorded phase is a hint, not an instruction: a crash can leave `APPLYING` on a member Git
 * finished, or on one it never started. Observed state decides. Anything that is neither the
 * requested state nor provably safe to reach is refused with what was found, and nothing is
 * deleted.
 */
export function classifyMemberRecovery(input: MemberRecoveryInput): MemberRecoveryAction {
  const { member } = input;
  const branchRef = `refs/heads/${input.branch}`;
  const context = {
    repositoryId: member.repositoryId,
    repository: member.repositoryMainRoot,
    path: member.worktreePath,
    branch: input.branch,
    phase: member.phase,
  };

  if (!input.repositoryRegistered) {
    return refuse('WTM_CONFIG_INVALID',
      `${member.repositoryMainRoot} is part of this creation but is no longer registered with WTM. `
      + 'Register it again with `wtm init`, then resume.', context);
  }
  if (member.phase === 'REGISTERED') return { action: 'skip' };

  const atPath = input.topology.find((record) => resolve(record.path) === resolve(member.worktreePath));
  if (atPath !== undefined) {
    if (atPath.prunableReason !== null) {
      return refuse('WTM_WORKTREE_PATH_OCCUPIED',
        `Git still records a worktree at ${member.worktreePath} that is gone (${atPath.prunableReason}). `
        + `Run \`git worktree prune\` in ${member.repositoryMainRoot}, then resume.`,
        context, [{ kind: 'command-suggestion', argv: ['git', '-C', member.repositoryMainRoot, 'worktree', 'prune'] }]);
    }
    if (atPath.branch === branchRef) return { action: 'mark-applied', worktree: atPath };
    return refuse('WTM_WORKTREE_PATH_OCCUPIED',
      `${member.worktreePath} is a worktree on ${atPath.branch ?? 'a detached HEAD'}, not on ${input.branch}.`,
      { ...context, foundBranch: atPath.branch });
  }

  const holder = input.topology.find((record) => record.branch === branchRef);
  if (holder !== undefined) {
    return refuse('GIT_BRANCH_IN_USE',
      `${input.branch} is checked out in ${holder.path}, not at ${member.worktreePath}.`,
      { ...context, worktreePath: holder.path });
  }
  if (input.pathExists) {
    return refuse('WTM_WORKTREE_PATH_OCCUPIED',
      `${member.worktreePath} exists but is not a worktree of ${member.repositoryMainRoot}. Move or remove it, then resume.`,
      context);
  }

  const base = { path: member.worktreePath, branch: input.branch, branchRef };
  if (input.branchOid === null) {
    return { action: 'apply', plan: { ...base, createsBranch: true, startPoint: member.startOid } };
  }
  if (member.branchExisted || input.branchOid === member.startOid) {
    return { action: 'apply', plan: { ...base, createsBranch: false, startPoint: null } };
  }
  return refuse('GIT_BRANCH_IN_USE',
    `${input.branch} points at ${input.branchOid}, not at ${member.startOid} where this creation started it, `
    + 'so it is not the branch this creation made.',
    { ...context, branchOid: input.branchOid, startOid: member.startOid });
}

function refuse(
  code: 'WTM_CONFIG_INVALID' | 'WTM_WORKTREE_PATH_OCCUPIED' | 'GIT_BRANCH_IN_USE',
  message: string,
  context: Record<string, unknown>,
  remediation?: readonly Remediation[],
): MemberRecoveryAction {
  return {
    action: 'refuse',
    error: { code, message, severity: 'error', context, ...(remediation === undefined ? {} : { remediation: [...remediation] }) },
  };
}
