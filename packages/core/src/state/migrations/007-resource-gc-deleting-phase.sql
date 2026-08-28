CREATE TABLE resource_gc_journal_next (
  operation_id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL REFERENCES resource_storage_objects(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'quarantined', 'deleting', 'deleted', 'finalized')),
  original_path TEXT NOT NULL,
  quarantine_path TEXT,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  sandbox_id TEXT NOT NULL,
  sandbox_generation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  updated_at TEXT NOT NULL
);

INSERT INTO resource_gc_journal_next (
  operation_id, storage_object_id, phase, original_path, quarantine_path,
  dev, ino, uid, sandbox_id, sandbox_generation, kind, updated_at
)
SELECT
  operation_id, storage_object_id, phase, original_path, quarantine_path,
  dev, ino, uid, sandbox_id, sandbox_generation, kind, updated_at
FROM resource_gc_journal;

DROP TABLE resource_gc_journal;
ALTER TABLE resource_gc_journal_next RENAME TO resource_gc_journal;

CREATE INDEX resource_gc_journal_phase
  ON resource_gc_journal (phase, updated_at);
