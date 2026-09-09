-- A row owns its global concurrency slot until the daemon proves its complete process tree
-- stopped. No FK cascade may erase this evidence during registration cleanup.
CREATE TABLE heavy_jobs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  task_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  state TEXT NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED')),
  slot_held INTEGER NOT NULL DEFAULT 0 CHECK (slot_held IN (0, 1)),
  process_id TEXT,
  anchor_pid INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  error TEXT,
  source_validity TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (source_validity IN ('UNCHANGED', 'CHANGED', 'UNKNOWN')),
  stop_reason TEXT CHECK (stop_reason IN ('CANCELLED', 'TIMED_OUT', 'INTERRUPTED')),
  UNIQUE (scope, idempotency_key)
);
CREATE INDEX idx_heavy_jobs_fifo ON heavy_jobs(scope, state, sequence);
CREATE INDEX idx_heavy_jobs_slots ON heavy_jobs(scope, slot_held, worktree_id);
CREATE INDEX idx_heavy_jobs_repository ON heavy_jobs(repository_id, state, slot_held);
-- Existing managed processes are host-unscoped. Bind the whole database before recovery,
-- rather than inspecting a foreign host's PID numbers against this machine.
CREATE TABLE heavy_job_state_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scope TEXT NOT NULL);
