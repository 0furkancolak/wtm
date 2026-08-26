# Data Model and State Machines

## Persistent database

Suggested location:

```text
~/Library/Application Support/WTM/state.db
```

SQLite is used for transactions and concurrent CLI/daemon correctness.

## Core tables

### `workspaces`

```text
id UUID primary key
name text
root text unique
scope local|global-only
config_path nullable
created_at
last_seen_at
```

### `repositories`

```text
id UUID primary key
workspace_id
common_git_dir
main_root
remote_identity nullable
created_at
last_reconciled_at
```

### `worktrees`

```text
id UUID primary key
repository_id
numeric_id integer
path
branch nullable
head_oid
is_main boolean
is_locked boolean
state
created_at
last_seen_at
last_runtime_at nullable
```

Unique constraint: `(repository_id, path)` and a stable allocation strategy for numeric IDs.

### `endpoint_leases`

```text
id UUID
worktree_id
name
protocol
port
state
allocated_at
last_verified_at
```

### `managed_processes`

```text
id UUID
worktree_id
task_name
pid
pgid
process_start_time
command_fingerprint
state
started_at
stopped_at nullable
stdout_path
stderr_path
```

### `resources`

```text
id UUID
owner_type
owner_id
adapter_id
name
resource_type
path nullable
policy
retention
state
created_at
last_used_at
last_verified_at
```

### `adapter_trust`

```text
adapter_id
canonical_path
sha256
trusted_at
```

### `cleanup_jobs`

```text
id UUID
owner_id
kind
payload_json
attempt
next_attempt_at
last_error nullable
state
```

## Worktree state

```text
DISCOVERED
  -> ALLOCATED
  -> PREPARING
  -> READY
  -> STARTING
  -> RUNNING
  -> STOPPING
  -> READY

Failure:
PREPARING/STARTING -> DEGRADED/FAILED

External disappearance:
READY/RUNNING -> ORPHANED -> CLEANING -> REMOVED
                               \
                                -> DEGRADED_CLEANUP -> retry
```

## Resource state

```text
DECLARED
 -> MATERIALIZING
 -> READY
 -> STALE
 -> RECONCILING
 -> READY

owner removed:
 -> ORPHANED
 -> RETAINED | REMOVED
```

## Process state

```text
STARTING -> RUNNING -> STOPPING -> STOPPED
    \          \
     FAILED     STALE_IDENTITY
```

`STALE_IDENTITY` means the stored PID no longer matches the originally tracked process. WTM drops/repairs the record and never signals the unrelated process.

## Transactions

SQLite transactions are mandatory for:

- stable numeric ID allocation;
- port lease allocation;
- process registration/start transitions;
- worktree disappearance -> cleanup ownership handoff.

## State vs cache vs logs

Persistent state:

```text
~/Library/Application Support/WTM/
```

Disposable cache:

```text
~/Library/Caches/WTM/
```

Logs:

```text
~/Library/Logs/WTM/
```

Deleting WTM cache must not lose worktree identity or safety data.
