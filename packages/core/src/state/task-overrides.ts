import type { TaskConfig } from '../config/schema';

export interface TaskOverrideRecord {
  worktreeId: string;
  taskName: string;
  task: TaskConfig;
  createdAt: string;
  updatedAt: string;
}

export interface TaskOverrideSetInput {
  worktreeId: string;
  taskName: string;
  task: TaskConfig;
  now: string;
}

/**
 * A worktree's `wtm task set` records. Kept apart from `StateStore`, like `CiWatchStore`: its
 * test doubles know nothing of task overrides.
 */
export interface TaskOverrideStore {
  /** Replaces the whole task definition; `wtm task set` never merges fields onto a prior row. */
  set(input: TaskOverrideSetInput): TaskOverrideRecord;
  get(worktreeId: string, taskName: string): TaskOverrideRecord | null;
  listForWorktree(worktreeId: string): TaskOverrideRecord[];
  /** True when a row existed and was removed. */
  unset(worktreeId: string, taskName: string): boolean;
  deleteForWorktree(worktreeId: string): number;
}
