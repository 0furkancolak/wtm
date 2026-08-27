ALTER TABLE managed_processes ADD COLUMN cleanup_required INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_required IN (0, 1));

ALTER TABLE managed_processes ADD COLUMN cleanup_owner_token TEXT;

-- Version 4 could durably retain a start reservation after its anchor had
-- already been recorded as STARTING/FAILED, but had no columns on which to
-- persist cleanup ownership.  A reservation owns at most one task lifecycle;
-- Ordinary starts have no replacement ID. Associate those only when the
-- newest lifecycle row overall is itself cleanup-capable; restart reservations
-- remain tied exclusively to their explicit replacement process.
UPDATE managed_processes AS candidate
SET cleanup_required = 1,
    cleanup_owner_token = (
      SELECT reservation.token
      FROM managed_process_start_reservations AS reservation
      WHERE reservation.worktree_id = candidate.worktree_id
        AND reservation.task_name = candidate.task_name
        AND reservation.replace_process_id IS NULL
    )
WHERE candidate.state IN ('STARTING', 'FAILED')
  AND candidate.id = (
    SELECT newest.id
    FROM managed_processes AS newest
    WHERE newest.worktree_id = candidate.worktree_id
      AND newest.task_name = candidate.task_name
    ORDER BY newest.started_at DESC, newest.id DESC
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM managed_process_start_reservations AS reservation
    WHERE reservation.worktree_id = candidate.worktree_id
      AND reservation.task_name = candidate.task_name
      AND reservation.replace_process_id IS NULL
  );

CREATE INDEX idx_managed_process_cleanup_required
  ON managed_processes(cleanup_required, state)
  WHERE cleanup_required = 1;
