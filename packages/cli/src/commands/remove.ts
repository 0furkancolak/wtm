import { basename } from 'node:path';
import {
  analyzeWorktree,
  GitCommandError,
  listGitWorktrees,
  removeWorktreeGuarded,
  RepositoryOperationConflictError,
  WorktreeRemovalBlockedError,
  type GitWorktreeRecord,
  type GuardedRemovalResult,
  type RemoteRefreshRecord,
  type ProcessStartTimeReader,
  type RemovalRuntimeCoordinator,
  type RepositoryOperationLeaseStore,
  type WorktreeAnalysis,
  type WorktreeContext,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { toGitSafetyError } from './git-error';
import { matchWorktreeSelector, type SelectorCandidate } from '../worktree-selector';

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
  /**
   * How the lease decides whether a colliding holder is still running. Core states the question
   * and refuses to answer it, so the platform choice arrives here from the composition root and
   * this command only passes it along.
   */
  readProcessStartTime: ProcessStartTimeReader;
  /** Which machine this process is running on. Travels with the lease for the same reason. */
  hostId: string;
  /** Takes over a lease abandoned by a dead holder. This is `--resume`. */
  adopt: boolean;
}

export interface RemoveCommandInput {
  repoPath: string;
  selector: string;
  /** Pre-collected candidates, from the shared selector's workspace-wide collection. */
  candidates?: readonly SelectorCandidate[];
  /** The repository names an ambiguous selector's `--repo` remediation may name. */
  repositories?: readonly string[];
  baseRef?: string;
  allowedRemoteRefs?: readonly string[];
  untrackedSymlinks?: WorktreeContext['untrackedSymlinks'];
  /** Resolve target-specific config after selector resolution and before any runtime action. */
  resolveSafety?: (worktreePath: string) => Promise<Pick<WorktreeContext, 'allowedRemoteRefs' | 'untrackedSymlinks'>>;
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

export async function runRemoveCommand(
  input: RemoveCommandInput,
): Promise<RemoveCommandEnvelope> {
  let warnings: WtmError[] = [];
  try {
    const candidates = input.candidates ?? (await listGitWorktrees(input.repoPath)).map((record, _, topology) => ({
      repository: { id: null, root: topology[0]?.path ?? input.repoPath, name: basename(topology[0]?.path ?? input.repoPath) },
      record,
      numericId: null,
    }));
    const matched = await matchWorktreeSelector({
      selector: input.selector, cwd: input.repoPath, candidates,
      repositories: input.repositories ?? [basename(candidates[0]?.repository.root ?? input.repoPath)],
    });
    if (matched.outcome === 'refused') return removalFailure(input, matched.error);
    const selected = matched.candidate.record;
    const safety = await input.resolveSafety?.(selected.path);
    const binding = input.bindRuntime?.(selected.path) ?? null;
    const context = analysisContext({ ...input, ...safety }, selected, binding);
    let result: GuardedRemovalResult;
    try {
      result = await removeWorktreeGuarded({
        context,
        ...(binding === null ? {} : {
          coordinator: binding.coordinator,
          lease: {
            store: binding.leaseStore,
            readProcessStartTime: binding.readProcessStartTime,
            hostId: binding.hostId,
            repositoryId: binding.repositoryId,
            adopt: binding.adopt,
          },
        }),
      });
    } catch (error) {
      if (error instanceof WorktreeRemovalBlockedError || error instanceof GitCommandError) warnings = await analysisWarnings(context);
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
 * The warnings accompanying a refused removal or a final Git veto.
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
    ...(input.untrackedSymlinks === undefined ? {} : { untrackedSymlinks: input.untrackedSymlinks }),
    ...(input.remoteRefresh === undefined ? {} : { remoteRefresh: input.remoteRefresh }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
    ...(input.worktreeNumericId === undefined ? {} : { worktreeNumericId: input.worktreeNumericId }),
  };
}

/** The failure envelope for a selector the shared selector refused to resolve. */
function removalFailure(input: RemoveCommandInput, error: WtmError): RemoveCommandEnvelope {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'remove',
    scope: commandScope(input),
    data: null,
    warnings: [],
    errors: [error],
  };
}

function commandScope(input: RemoveCommandInput): { mode: 'local'; workspaceId?: string } {
  return {
    mode: 'local',
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  };
}
