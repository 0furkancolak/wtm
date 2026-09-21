-- A task override is a first-party record written by `wtm task set` that takes precedence over
-- the same task name in `wtm.toml` and over any adapter-derived task, using the same
-- `mergeConfigLayers` precedence machinery as any file-based layer (see
-- `packages/daemon/src/task-resolution.ts`). The whole task definition lives in `task_json`,
-- validated against the same schema `[tasks.<name>]` is, so `wtm task export` can write it back
-- into `wtm.toml` without a second serialization path.
--
-- Worktree-scoped, like `ci_watches`: no FK to worktrees, since worktree rows are never deleted
-- — `wtm remove` deletes a worktree's overrides explicitly
-- (`packages/cli/src/removal-coordinator.ts`).
CREATE TABLE task_overrides (
  worktree_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  task_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worktree_id, task_name)
);
