import type { CiRun, CiWatchState, WtmErrorCode } from '@wtm/protocol';

export interface CiWatchRecord {
  watchId: string;
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
  providerRepo: string;
  branch: string | null;
  headSha: string;
  pr: number | null;
  state: CiWatchState;
  detail: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  nextPollAt: string;
  pollIntervalMs: number;
  failureStreak: number;
  sawRuns: boolean;
  runs: CiRun[];
}

export interface CiWatchStartInput {
  repositoryId: string;
  worktreeId: string;
  worktreePath: string;
  providerRepo: string;
  branch: string | null;
  headSha: string;
  pr: number | null;
  now: string;
  nextPollAt: string;
  pollIntervalMs: number;
  maxPending: number;
}

export interface CiWatchUpdate {
  now: string;
  state?: CiWatchState;
  detail?: string | null;
  /** `wtm ci watch --pr <n>` attaching a PR number to a watch the same commit already reuses. */
  pr?: number | null;
  nextPollAt?: string;
  pollIntervalMs?: number;
  failureStreak?: number;
  sawRuns?: boolean;
  runs?: CiRun[];
}

/** Kept apart from `StateStore`, like `FeatureCreationStore`: its test doubles know nothing of CI. */
export interface CiWatchStore {
  /** Reuses the pending watch of the same commit; supersedes a pending watch of another commit. */
  start(input: CiWatchStartInput): { watch: CiWatchRecord; reused: boolean };
  get(watchId: string): CiWatchRecord | null;
  latestForWorktree(worktreeId: string): CiWatchRecord | null;
  pending(): CiWatchRecord[];
  /** Changes a pending watch; a finished watch is returned unchanged. A terminal `state` sets `finishedAt`. */
  update(watchId: string, update: CiWatchUpdate): CiWatchRecord | null;
  cancelPendingForWorktree(worktreeId: string, now: string, detail: string): CiWatchRecord | null;
  deleteForWorktree(worktreeId: string): number;
  /** Deletes watches finished more than `retentionMs` ago, and superseded watches whose worktree has a newer finished watch. */
  prune(now: string, retentionMs: number): number;
}

export class CiWatchError extends Error {
  constructor(readonly code: WtmErrorCode, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CiWatchError';
  }
}
