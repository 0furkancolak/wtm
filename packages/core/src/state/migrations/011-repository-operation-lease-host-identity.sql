-- Distinguishes a lease holder on this host from a holder on another host sharing this
-- state.db over a network HOME (spec 2026-09-01-platform-seam-design.md D5, todo item 44).
--
-- The default '' marks every row acquired before this column existed. `livenessOf`
-- (operation-lease.ts) never treats an empty or mismatched host_id as "this host" -- it reads as
-- `unknown`, which the store treats exactly like `alive` for reclaim purposes -- so a legacy row
-- is never wrongly abandoned; at worst it stays a conflict a little longer than a fully-identified
-- one would.
ALTER TABLE repository_operation_leases ADD COLUMN host_id TEXT NOT NULL DEFAULT '';
