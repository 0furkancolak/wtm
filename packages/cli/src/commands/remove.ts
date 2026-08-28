import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  listGitWorktrees,
  removeWorktreeSafely,
  WorktreeRemovalBlockedError,
  type GitWorktreeRecord,
  type WorktreeAnalysis,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { toGitSafetyError } from './git-error';

export interface RemoveCommandInput {
  repoPath: string;
  selector: string;
  baseRef?: string;
  allowedRemoteRefs?: readonly string[];
  workspaceId?: string;
  repositoryId?: string;
  worktreeId?: string;
  worktreeNumericId?: number;
}

export interface RemoveCommandResult {
  removed: {
    path: string;
    branchRef: string | null;
    headOid: string;
  };
  analysis: WorktreeAnalysis;
}

export type RemoveCommandEnvelope = JsonEnvelope<RemoveCommandResult | null>;

class WorktreeSelectorError extends Error {
  readonly code = 'WTM_WORKSPACE_NOT_FOUND' as const;
  readonly context: Record<string, unknown>;

  constructor(input: RemoveCommandInput) {
    super('The explicit worktree selector did not resolve to exactly one discovered worktree.');
    this.name = 'WorktreeSelectorError';
    this.context = { repoPath: input.repoPath, selector: input.selector };
  }
}

export async function runRemoveCommand(
  input: RemoveCommandInput,
): Promise<RemoveCommandEnvelope> {
  let warnings: WtmError[] = [];
  try {
    const selected = await resolveExplicitSelector(input);
    const finalAnalysis = await removeWorktreeSafely(analysisContext(input, selected));
    warnings = [...finalAnalysis.safety.warnings];
    return {
      schemaVersion: 1,
      ok: true,
      command: 'remove',
      scope: commandScope(input),
      data: {
        removed: {
          path: finalAnalysis.identity.path,
          branchRef: finalAnalysis.identity.branchRef,
          headOid: finalAnalysis.identity.headOid,
        },
        analysis: finalAnalysis,
      },
      warnings,
      errors: [],
    };
  } catch (error) {
    const errors = error instanceof WorktreeRemovalBlockedError
      ? [...error.blockers]
      : [toGitSafetyError(error, 'remove')];
    return {
      schemaVersion: 1,
      ok: false,
      command: 'remove',
      scope: commandScope(input),
      data: null,
      warnings,
      errors: errors as [WtmError, ...WtmError[]],
    };
  }
}

function analysisContext(
  input: RemoveCommandInput,
  selected: GitWorktreeRecord,
): Parameters<typeof removeWorktreeSafely>[0] {
  return {
    repoPath: input.repoPath,
    worktreePath: selected.path,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    ...(input.allowedRemoteRefs === undefined ? {} : { allowedRemoteRefs: input.allowedRemoteRefs }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    ...(input.worktreeNumericId === undefined ? {} : { worktreeNumericId: input.worktreeNumericId }),
  };
}

async function resolveExplicitSelector(input: RemoveCommandInput): Promise<GitWorktreeRecord> {
  if (input.selector.trim().length === 0) throw new WorktreeSelectorError(input);
  const topology = await listGitWorktrees(input.repoPath);
  const canonicalPath = await canonicalSelectorPath(input.repoPath, input.selector);
  const fullBranchRef = input.selector.startsWith('refs/heads/')
    ? input.selector
    : `refs/heads/${input.selector}`;
  const matches = topology.filter((record) =>
    !record.bare
    && (
      record.path === input.selector
      || record.path === canonicalPath
      || record.branch === input.selector
      || record.branch === fullBranchRef
    )
  );
  if (matches.length !== 1 || matches[0] === undefined) throw new WorktreeSelectorError(input);
  return matches[0];
}

async function canonicalSelectorPath(repoPath: string, selector: string): Promise<string | null> {
  try {
    return await realpath(isAbsolute(selector) ? selector : resolve(repoPath, selector));
  } catch {
    return null;
  }
}

function commandScope(input: RemoveCommandInput): { mode: 'local'; workspaceId?: string } {
  return {
    mode: 'local',
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
}
