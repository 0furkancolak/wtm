-- Multi-repository `wtm create` (spec 2026-09-13-multi-repo-create-design.md).
--
-- `repository_operation_leases` is rebuilt only to widen its CHECK: SQLite cannot alter a CHECK
-- in place. Every column, including migration 011's `host_id`, is copied unchanged.
CREATE TABLE repository_operation_leases_next (
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  operation           TEXT NOT NULL CHECK (operation IN ('remove', 'gc', 'repair', 'create')),
  token               TEXT NOT NULL,
  pid                 INTEGER NOT NULL,
  process_start_time  TEXT NOT NULL,
  subject_worktree_id TEXT,
  stage               TEXT,
  acquired_at         TEXT NOT NULL,
  renewed_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  host_id             TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repository_id, operation)
);

INSERT INTO repository_operation_leases_next (
  repository_id, operation, token, pid, process_start_time, subject_worktree_id, stage,
  acquired_at, renewed_at, expires_at, host_id
)
SELECT
  repository_id, operation, token, pid, process_start_time, subject_worktree_id, stage,
  acquired_at, renewed_at, expires_at, host_id
FROM repository_operation_leases;

DROP TABLE repository_operation_leases;
ALTER TABLE repository_operation_leases_next RENAME TO repository_operation_leases;

CREATE INDEX idx_repository_operation_lease_expiry
  ON repository_operation_leases(expires_at);

-- A feature is the runtime's existing grouping, "one workspace, one full branch ref", given a
-- durable id. The grouping rule itself is unchanged, so the row and the group cannot disagree.
CREATE TABLE features (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, branch)
);

CREATE TABLE feature_creations (
  id           TEXT PRIMARY KEY,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  state        TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'SUPERSEDED')),
  from_ref     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX feature_creations_one_open
  ON feature_creations(feature_id) WHERE state = 'IN_PROGRESS';

-- `repository_id` has no foreign key on purpose: forgetting a repository must leave the member
-- visible, so `--resume` can refuse by naming it instead of silently finishing without it.
CREATE TABLE feature_creation_members (
  creation_id          TEXT NOT NULL REFERENCES feature_creations(id) ON DELETE CASCADE,
  repository_id        TEXT NOT NULL,
  repository_main_root TEXT NOT NULL,
  position             INTEGER NOT NULL,
  worktree_path        TEXT NOT NULL,
  branch_existed       INTEGER NOT NULL CHECK (branch_existed IN (0, 1)),
  start_oid            TEXT NOT NULL,
  phase                TEXT NOT NULL CHECK (phase IN ('PLANNED', 'APPLYING', 'APPLIED', 'REGISTERED')),
  last_error_code      TEXT,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (creation_id, repository_id),
  UNIQUE (creation_id, position)
);
