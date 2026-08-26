CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('local', 'global-only')),
  config_path TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  common_git_dir TEXT NOT NULL,
  main_root TEXT NOT NULL,
  remote_identity TEXT,
  created_at TEXT NOT NULL,
  last_reconciled_at TEXT,
  UNIQUE (workspace_id, common_git_dir)
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  numeric_id INTEGER NOT NULL CHECK (numeric_id > 0),
  path TEXT NOT NULL,
  branch TEXT,
  head_oid TEXT,
  is_main INTEGER NOT NULL CHECK (is_main IN (0, 1)),
  is_locked INTEGER NOT NULL CHECK (is_locked IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN (
    'DISCOVERED',
    'ALLOCATED',
    'PREPARING',
    'READY',
    'STARTING',
    'RUNNING',
    'STOPPING',
    'DEGRADED',
    'FAILED',
    'ORPHANED',
    'CLEANING',
    'REMOVED',
    'DEGRADED_CLEANUP'
  )),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_runtime_at TEXT,
  UNIQUE (repository_id, path),
  UNIQUE (repository_id, numeric_id)
);

CREATE TABLE endpoint_leases (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('tcp', 'udp')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED')),
  allocated_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  UNIQUE (worktree_id, name)
);

CREATE UNIQUE INDEX endpoint_leases_active_endpoint
  ON endpoint_leases (protocol, port)
  WHERE state = 'ACTIVE';

CREATE TABLE managed_processes (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,
  process_start_time TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'STARTING',
    'RUNNING',
    'STOPPING',
    'STOPPED',
    'FAILED',
    'STALE_IDENTITY'
  )),
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  path TEXT,
  policy TEXT NOT NULL,
  retention TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'DECLARED',
    'MATERIALIZING',
    'READY',
    'STALE',
    'RECONCILING',
    'ORPHANED',
    'RETAINED',
    'REMOVED'
  )),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, adapter_id, name)
);

CREATE TABLE adapter_trust (
  adapter_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  trusted_at TEXT NOT NULL,
  PRIMARY KEY (adapter_id, canonical_path)
);

CREATE TABLE cleanup_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  state TEXT NOT NULL
);
