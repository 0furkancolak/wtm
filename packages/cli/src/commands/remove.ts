import { basename, isAbsolute, resolve } from 'node:path';
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

  constructor(input: RemoveCommandInput, matches = 0) {
    super(matches > 1
      ? `More than one worktree matches ${input.selector}. Name it by branch or by path.`
      // Saying only that the selector did not resolve leaves the reader guessing at the
      // spellings, and a relative path is read from the repository root rather than from here.
      : `No worktree matches ${input.selector}. Name one by branch, by directory name, by number, or by path relative to ${input.repoPath}.`);
    this.name = 'WorktreeSelectorError';
    this.context = { repoPath: input.repoPath, selector: input.selector, matches };
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
      // The name of the directory, which is how a worktree is referred to out loud and the
      // only spelling that means the same thing from every directory in the workspace.
      || basename(record.path) === input.selector
      || record.branch === input.selector
      || record.branch === fullBranchRef
    )
  );
  if (matches.length !== 1 || matches[0] === undefined) throw new WorktreeSelectorError(input, matches.length);
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
