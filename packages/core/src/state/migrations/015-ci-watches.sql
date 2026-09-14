-- A CI watch is the daemon's record of an explicit `wtm ci watch`. Like heavy jobs it carries no FK
-- to worktrees: worktree rows are never deleted, so `wtm remove` deletes a worktree's watches
-- explicitly. Runs belong to their watch and go with it.
CREATE TABLE ci_watches (
  watch_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  provider_repo TEXT NOT NULL,
  branch TEXT,
  head_sha TEXT NOT NULL,
  pr INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'failure', 'cancelled', 'timed_out', 'no_runs', 'superseded', 'unavailable')),
  detail TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  next_poll_at TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL CHECK (poll_interval_ms > 0),
  failure_streak INTEGER NOT NULL DEFAULT 0 CHECK (failure_streak >= 0),
  saw_runs INTEGER NOT NULL DEFAULT 0 CHECK (saw_runs IN (0, 1))
);
CREATE INDEX idx_ci_watches_worktree ON ci_watches(worktree_id, sequence);
CREATE INDEX idx_ci_watches_state ON ci_watches(state, next_poll_at);
CREATE UNIQUE INDEX idx_ci_watches_one_pending ON ci_watches(worktree_id) WHERE state = 'pending';
CREATE TABLE ci_runs (
  watch_id TEXT NOT NULL REFERENCES ci_watches(watch_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  run_json TEXT NOT NULL,
  PRIMARY KEY (watch_id, position)
);
