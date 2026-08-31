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

### `repository_operation_leases`

```text
repository_id       references repositories(id) on delete cascade
operation           remove|gc|repair
token
pid
process_start_time
subject_worktree_id nullable
stage               nullable
acquired_at
renewed_at
expires_at

primary key (repository_id, operation)
```

Which process is performing a destructive operation on a repository, and how far it got. Before
this table the repository mutex was a `Map` inside one process, so two `wtm` processes — or the CLI
and the daemon — did not serialize against each other at all.

**The key is the resource.** There is no separate lock object to acquire: the primary key
`(repository_id, operation)` means the insert itself is the acquisition, and an insert conflict
*is* the lock being held. This follows `managed_process_start_reservations`, and it is why the
mechanism cannot drift out of step with what it protects. `operation` is in the key rather than the
table being one row per repository because a `gc` and a `remove` on one repository are not the same
conflict; which operations exclude each other is declared in code, and a fourth operation can be
added without a table rebuild. V1 declares all three mutually exclusive per repository.

**`pid` plus `process_start_time` is the identity.** `process_start_time` is the verbatim
`ps -o lstart=` string, exactly as `managed_processes` already stores it, so the two subsystems
compare identity the same way and a recycled PID can never satisfy a stale-lease recovery.

**`expires_at` is ISO-8601 TEXT compared with a plain `<=` against a caller-supplied `now`**, the
same way the managed-process reservations compare theirs. A caller supplying the timestamp is what
lets a test state a timeline instead of racing a wall clock, and using one comparison for both
subsystems is what keeps them from disagreeing about what "expired" means. There is no renewal
heartbeat: a lapsed TTL never evicts a live holder, so an operation that outruns its TTL is already
safe, and a timer would only add a part that can stop firing under load.

**`stage` makes the row the journal.** Each stage of the operation is recorded on the lease as it is
entered, so an interrupted operation leaves exactly one row to reason about, and that row cannot
disagree with the lock — losing the lease and losing the journal are the same event. Only the
holding token may write a stage, which is also what keeps a displaced owner from writing over its
successor's progress.

**The adoption rule.** A colliding lease is resolved in three steps, inside one transaction:

| The existing lease | Result |
| --- | --- |
| not expired | `conflict` — reported with the holder |
| expired, owner still alive | `conflict` — a lapsed TTL is not evidence that anyone is gone |
| expired, owner provably gone, caller did not ask to resume | `abandoned` — reported with the holder and its stage |
| expired, owner provably gone, caller asked to resume | `acquired`, carrying the abandoned stage forward |

Liveness is the caller's verdict, not SQL's: the store cannot run `ps` and must not spawn one per
row, so the verdict is measured for the single row the acquisition collides with, and only once
that row has expired. A verdict measured from a different row than the one found inside the
transaction is discarded and the acquisition retried once; the conservative answer there is
`alive`, because it costs a retry, while a wrong `gone` puts two processes inside one destruction.
No liveness reader at all counts as no evidence of life, so a caller that cannot run `ps` can still
recover a crashed holder's lease rather than being locked out of the repository forever.

An adopted lease keeps the stage the dead process wrote, so if the resuming process also dies the
next one still learns how far the first one got. The stage is reported, not obeyed: `--resume`
re-runs the lifecycle from the top, because every stage is idempotent and the journal says where a
process stopped writing, not what it finished doing.

`forgetWorkspace` and `forgetRepository` delete from this table explicitly. The FK cascade is
declared as well; the explicit delete is what the tests assert.

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
- destructive-operation lease acquisition, stage journalling and release;
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
