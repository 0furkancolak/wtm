-- Which lifecycle events have already been announced, so that an event describing something
-- that happens once — a worktree being discovered, a repository being registered — is
-- dispatched once and not again on the next daemon start.
CREATE TABLE lifecycle_event_dispatches (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('workspace', 'repository', 'worktree')),
  subject_id TEXT NOT NULL,
  event TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_id, event)
);
