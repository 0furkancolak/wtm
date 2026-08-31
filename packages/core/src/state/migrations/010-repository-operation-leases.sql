-- Which process is performing a destructive operation on a repository, and how far it got.
--
-- The repository mutex was a map inside one process, so two `wtm` processes — or the CLI and
-- the daemon — did not serialize against each other at all. The primary key is the resource,
-- so an insert conflict is the refusal, exactly as it is for managed process start
-- reservations. `operation` joins the key because a `gc` and a `remove` on one repository are
-- not the same conflict; which operations exclude each other is declared in code.
--
-- `pid` and `process_start_time` are the identity pair, and `process_start_time` is the
-- verbatim `ps -o lstart=` string that `managed_processes` already stores, so a recycled PID
-- cannot satisfy a stale-lease recovery. `stage` makes the row the journal of an interrupted
-- operation: there is exactly one row to reason about, and it cannot disagree with the lock.
CREATE TABLE repository_operation_leases (
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  operation           TEXT NOT NULL CHECK (operation IN ('remove', 'gc', 'repair')),
  token               TEXT NOT NULL,
  pid                 INTEGER NOT NULL,
  process_start_time  TEXT NOT NULL,
  subject_worktree_id TEXT,
  stage               TEXT,
  acquired_at         TEXT NOT NULL,
  renewed_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  PRIMARY KEY (repository_id, operation)
);

CREATE INDEX idx_repository_operation_lease_expiry
  ON repository_operation_leases(expires_at);
