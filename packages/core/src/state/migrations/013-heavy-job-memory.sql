-- A reservation follows slot ownership, including cancellation and uncertain cleanup.
-- NULL preserves legacy admission; enabling memory admission refuses unestimated queued
-- jobs and waits for unestimated held jobs to be proved stopped.
ALTER TABLE heavy_jobs ADD COLUMN memory_estimate_bytes INTEGER
  CHECK (memory_estimate_bytes IS NULL OR (memory_estimate_bytes > 0 AND memory_estimate_bytes <= 1099511627776));
