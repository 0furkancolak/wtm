export interface ChecklistItemRecord {
  worktreeId: string;
  position: number;
  text: string;
  checked: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A worktree's `wtm checklist set` items — the agent-writes/user-checks dev-overlay checklist
 * (todo item 46b, W11-1). Kept apart from `StateStore`, like `TaskOverrideStore`: its test
 * doubles know nothing of checklists.
 */
export interface ChecklistStore {
  /**
   * Replaces the whole checklist for a worktree: deletes the prior list and inserts this one,
   * unchecked, in one transaction — the same replace-not-merge convention `TaskOverrideStore.set`
   * uses, and the reason `position` alone is a stable enough id for the browser-side toggle: a
   * `set` is the only way an item's text ever changes, and it always throws the old list away.
   */
  set(worktreeId: string, items: readonly string[], now: string): ChecklistItemRecord[];
  list(worktreeId: string): ChecklistItemRecord[];
  /** Updates one item's `checked` state by position; `null` when no row exists at that position. */
  setChecked(worktreeId: string, position: number, checked: boolean, now: string): ChecklistItemRecord | null;
  /** Deletes every item of a worktree; the count removed. */
  clear(worktreeId: string): number;
  deleteForWorktree(worktreeId: string): number;
}
