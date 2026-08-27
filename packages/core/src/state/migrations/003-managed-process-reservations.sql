CREATE TABLE managed_process_start_reservations (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (worktree_id, task_name)
);
