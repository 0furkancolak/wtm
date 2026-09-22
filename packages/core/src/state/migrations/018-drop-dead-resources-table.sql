-- The `resources` table (migration 001) predates the sandbox/storage-object lifecycle
-- (migration 006 onward) and was superseded by it before any code ever read or wrote a row.
-- No store method in sqlite-store.ts references it; it is dead schema. See decision K12
-- (docs/superpowers/plans/2026-09-21-release-readiness-audit.md) for the removal record.
DROP TABLE resources;
