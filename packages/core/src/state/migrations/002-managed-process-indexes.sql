CREATE INDEX managed_processes_owner_task_started
  ON managed_processes (worktree_id, task_name, started_at, id);

CREATE INDEX managed_processes_state
  ON managed_processes (state);
