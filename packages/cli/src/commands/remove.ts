import { basename, isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  analyzeWorktree,
  listGitWorktrees,
  removeWorktreeGuarded,
  RepositoryOperationConflictError,
  WorktreeRemovalBlockedError,
  type GitWorktreeRecord,
  type GuardedRemovalResult,
  type RemoteRefreshRecord,
  type RemovalRuntimeCoordinator,
  type RepositoryOperationLeaseStore,
  type WorktreeAnalysis,
  type WorktreeContext,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { toGitSafetyError } from './git-error';

/**
 * The runtime half of one removal, resolved only once the selector has named a worktree.
 *
 * It is a callback rather than four more input fields because the ids and the coordinator all
 * depend on *which* worktree was selected, and the selector is resolved in here. Returning null
 * runs the Git-only path — a worktree WTM has no registration for has no processes, leases or
 * resources for a coordinator to act on.
 */
export interface RemovalRuntimeBinding {
  repositoryId: string;
  worktreeId: string;
  coordinator: RemovalRuntimeCoordinator;
  leaseStore: RepositoryOperationLeaseStore;
  /** Takes over a lease abandoned by a dead holder. This is `--resume`. */
  adopt: boolean;
}

export interface RemoveCommandInput {
  repoPath: string;
  selector: string;
  baseRef?: string;
  allowedRemoteRefs?: readonly string[];
  /** A refresh the caller already performed, passed through to analysis unchanged. */
  remoteRefresh?: RemoteRefreshRecord;
  workspaceId?: string;
  repositoryId?: string;
  worktreeId?: string;
  worktreeNumericId?: number;
  bindRuntime?: (worktreePath: string) => RemovalRuntimeBinding | null;
}

export interface RemoveCommandResult {
  removed: {
    path: string;
    branchRef: string | null;
    headOid: string;
  };
  /** What the runtime gave back before Git ran. Zeroed on the Git-only path. */
  cleanup: GuardedRemovalResult['cleanup'];
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
    const binding = input.bindRuntime?.(selected.path) ?? null;
    const context = analysisContext(input, selected, binding);
    let result: GuardedRemovalResult;
    try {
      result = await removeWorktreeGuarded({
        context,
        ...(binding === null ? {} : {
          coordinator: binding.coordinator,
          lease: { store: binding.leaseStore, repositoryId: binding.repositoryId, adopt: binding.adopt },
        }),
      });
    } catch (error) {
      if (error instanceof WorktreeRemovalBlockedError) warnings = await analysisWarnings(context);
      throw error;
    }
    warnings = [...result.analysis.safety.warnings];
    return {
      schemaVersion: 1,
      ok: true,
      command: 'remove',
      scope: commandScope(input),
      data: {
        removed: {
          path: result.analysis.identity.path,
          branchRef: result.analysis.identity.branchRef,
          headOid: result.analysis.identity.headOid,
        },
        cleanup: result.cleanup,
        analysis: result.analysis,
      },
      warnings,
      errors: [],
    };
  } catch (error) {
    const errors = error instanceof WorktreeRemovalBlockedError
      ? [...error.blockers]
      : [removalError(error, input)];
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

/**
 * The warnings of the analysis that refused this removal.
 *
 * `WorktreeRemovalBlockedError` carries the blockers alone, and the analysis they came from
 * never leaves the lifecycle, so recovering them means asking again — one read-only analysis, on
 * a path that has already failed. It is worth the second look: the warnings are what say the
 * base ref is missing or the upstream is gone, and dropping them silently on exactly the runs
 * where the reader is trying to work out why removal was refused is the worst time to lose them.
 * If the second analysis cannot run at all, the blockers still stand on their own.
 */
async function analysisWarnings(context: WorktreeContext): Promise<WtmError[]> {
  try {
    return [...(await analyzeWorktree(context)).safety.warnings];
  } catch {
    return [];
  }
}

/**
 * Core cannot know which worktree the caller named, so the `--resume` it suggests is the bare
 * command. The person reading this typed a selector; handing it back is the difference between a
 * hint and something they can run.
 */
function removalError(error: unknown, input: RemoveCommandInput): WtmError {
  const reported = toGitSafetyError(error, 'remove');
  if (!(error instanceof RepositoryOperationConflictError) || !error.abandoned) return reported;
  return {
    ...reported,
    remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'remove', input.selector, '--resume'] }],
  };
}

function analysisContext(
  input: RemoveCommandInput,
  selected: GitWorktreeRecord,
  binding: RemovalRuntimeBinding | null,
): WorktreeContext {
  // A coordinator acts on recorded ids, so the binding's are authoritative when there is one:
  // they and the coordinator were resolved from the same registration.
  const repositoryId = binding?.repositoryId ?? input.repositoryId;
  const worktreeId = binding?.worktreeId ?? input.worktreeId;
  return {
    repoPath: input.repoPath,
    worktreePath: selected.path,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    ...(input.allowedRemoteRefs === undefined ? {} : { allowedRemoteRefs: input.allowedRemoteRefs }),
    ...(input.remoteRefresh === undefined ? {} : { remoteRefresh: input.remoteRefresh }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
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
