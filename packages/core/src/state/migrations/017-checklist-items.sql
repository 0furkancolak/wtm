-- The dev overlay's agent-writes/user-checks checklist (todo item 46b, W11-1). Item 46's own
-- text says this belongs on the same persisted-record pattern `task_overrides` (item 49)
-- established, not a new storage model of its own — worktree-scoped, written only through the
-- access-controlled local socket, `set` always replacing the whole prior value rather than
-- merging. A checklist item is not a runnable task, so this is its own table, following that
-- pattern rather than reusing `task_overrides` literally.
--
-- `position` (0-based) doubles as the item's stable id, deliberately: `wtm checklist set` always
-- replaces the entire list for a worktree (the same replace-not-merge convention `wtm task set`
-- already uses), so there is never a case of adding or removing a single item by id through the
-- CLI — only `checked` is ever updated in place afterward, by position, from the browser side via
-- the proxy's `/__wtm/checklist` endpoint (`packages/daemon/src/proxy.ts`, `dev-overlay.ts`).
--
-- Worktree-scoped, like `task_overrides` and `ci_watches`: no FK to worktrees, since worktree rows
-- are never deleted — `wtm remove` deletes a worktree's checklist items explicitly
-- (`packages/cli/src/removal-coordinator.ts`).
CREATE TABLE checklist_items (
  worktree_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worktree_id, position)
);
