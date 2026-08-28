CREATE TABLE resource_sandboxes (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  generation TEXT NOT NULL,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (root, generation)
);

CREATE TABLE resource_storage_objects (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES resource_sandboxes(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  state TEXT NOT NULL CHECK (state IN ('READY', 'STALE', 'ORPHANED', 'QUARANTINED', 'REMOVED')),
  retention TEXT NOT NULL CHECK (retention IN ('ephemeral', 'persistent')),
  owned INTEGER NOT NULL CHECK (owned IN (0, 1)),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
  allocated_bytes INTEGER NOT NULL CHECK (allocated_bytes >= 0),
  UNIQUE (sandbox_id, path)
);

CREATE TABLE resource_references (
  id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL REFERENCES resource_storage_objects(id) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX resource_references_active_owner
  ON resource_references (storage_object_id, owner_type, owner_id, resource_name)
  WHERE released_at IS NULL;

CREATE TABLE resource_cleanup_leases (
  storage_object_id TEXT PRIMARY KEY REFERENCES resource_storage_objects(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  sandbox_generation TEXT NOT NULL,
  path TEXT NOT NULL,
  dev INTEGER NOT NULL,
  ino INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
  previous_state TEXT NOT NULL CHECK (previous_state IN ('STALE', 'ORPHANED', 'QUARANTINED')),
  retention TEXT NOT NULL CHECK (retention IN ('ephemeral', 'persistent')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE resource_gc_journal (
  operation_id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL REFERENCES resource_storage_objects(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'quarantined', 'deleted', 'finalized')),
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

CREATE INDEX resource_storage_objects_gc
  ON resource_storage_objects (sandbox_id, state, retention, last_used_at);

CREATE INDEX resource_gc_journal_phase
  ON resource_gc_journal (phase, updated_at);
