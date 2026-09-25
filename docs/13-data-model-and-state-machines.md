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

### `resource_sandboxes`

```text
id UUID
root
generation
dev
ino
uid
created_at

unique (root, generation)
```

One row per generation of a `[resources]` sandbox root (`<workspaceRoot>/.resources`, see
[docs/08](08-storage-cache-gc.md#resource-registry)). `dev`/`ino`/`uid` pin the directory's
on-disk identity the same way `worktrees` pins a repository's, so a root reused after the
filesystem underneath it changed cannot silently inherit an earlier generation's rows.

### `resource_storage_objects`

```text
id UUID
sandbox_id       references resource_sandboxes(id) on delete restrict
path
dev / ino / uid
kind             file|directory
state            READY|STALE|ORPHANED|QUARANTINED|REMOVED
retention        ephemeral|persistent
owned
created_at / last_used_at / last_verified_at
logical_bytes / allocated_bytes

unique (sandbox_id, path)
```

One row per physical object a sandbox's GC can account for; `state` is described under [Resource
GC state](#resource-gc-state) below. As of this writing `upsertResourceSandbox`/
`registerResourceStorageObject` are called only by tests — no production code path populates these
rows, and by **decision K12** (2026-09-22,
`docs/superpowers/plans/2026-09-21-release-readiness-audit.md`) none will for v0.2.0: this is not a
missing wire between two existing systems. `materializer.ts`/`guard.ts`
(`planResourceMaterialization`, `applyMaterializationPlan`, `createResourceGuard`), the engine that
would produce these rows, has zero production callers of its own — only tests and the
`core/index.ts` re-export reference it. The real production resource path today
(`packages/core/src/resources/preparation.ts`, driven by `wtm run`/`wtm resolve --prepare`) is a
separate, purely filesystem-level pipeline for `[resources]`-declared worktree-local files, and per
[docs/08](08-storage-cache-gc.md#worktree-local-resources) it must never call into this sandbox
engine — connecting the two would defeat the tested invariant that GC never walks a Git working
tree. The plan/apply/recovery machinery downstream of `resource_storage_objects` (`buildGcPlan`,
`applyGcPlan`, `recoverGcJournalEntry`) is real and exercised by its own tests; what feeds it real
rows is a still-unspecified adapter-declared shared-resource feature that docs/07 and docs/08
already scope out of V1 (same category as the Docker container/network/volume gap docs/07
describes) — see K12's record for the evidence and the open design questions a future unit would
need answered first.

### `resource_references`

```text
id UUID
storage_object_id   references resource_storage_objects(id) on delete restrict
owner_type
owner_id
resource_name
created_at
released_at nullable

unique (storage_object_id, owner_type, owner_id, resource_name) where released_at is null
```

A held reference is a row with `released_at IS NULL`. `listResourceGcEvidence`'s reference count
is exactly this count, and it is what `buildGcPlan`'s `live-reference` exclusion checks — a
storage object with any active reference is never a GC candidate, regardless of its own `state`.

### `resource_cleanup_leases`

```text
storage_object_id primary key   references resource_storage_objects(id) on delete cascade
token
sandbox_id / sandbox_generation
path / dev / ino / uid / kind
previous_state    STALE|ORPHANED|QUARANTINED
retention
acquired_at
expires_at
```

Mirrors `repository_operation_leases` above: the primary key is the resource, so acquiring the
lease and holding it are the same row. `applyGcPlan` holds one per candidate for the whole
quarantine-through-finalize sequence; `previous_state` is what `resource_storage_objects.state`
reverts to if the lease is released before finishing, so a crashed GC never leaves an object stuck
in `QUARANTINED` with no honest candidate/excluded reading in the next plan.

### `resource_gc_journal`

```text
operation_id UUID primary key
storage_object_id   references resource_storage_objects(id) on delete restrict
phase   prepared|linked|unlinking|quarantined|deleting|deleted|finalized
original_path
quarantine_path nullable
quarantine_container_path/dev/ino/uid/mode   nullable, all-or-nothing
dev / ino / uid
sandbox_id / sandbox_generation
kind
updated_at
```

The crash-recovery record for one destructive GC operation, described under [Resource GC
state](#resource-gc-state) below. `recoverGcJournalEntry` resumes strictly from `phase`, so an
operation interrupted mid-way never has to re-derive where it stopped from filesystem probing
alone. Rows are never deleted — `finalized` is a terminal label, not a row removal.

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

### `task_overrides`

```text
worktree_id
task_name
task_json
created_at
updated_at

primary key (worktree_id, task_name)
```

Written by `wtm task set`; read back by `wtm task list/show/unset/export`. The whole task
definition lives in `task_json`, validated against the same schema as `[tasks.<name>]` in
`wtm.toml`, so an override outranks a `wtm.toml` task and any adapter-derived task of the same name
(see [K3](03-configuration-spec.md), [`wtm task`](04-cli-reference.md#task-overrides)) without a
second serialization path. Worktree-scoped with no foreign key, like `ci_watches` below: worktree
rows are never deleted, so `wtm remove` deletes a worktree's overrides explicitly.

### `heavy_jobs`

```text
sequence integer primary key autoincrement
job_id unique
scope
workspace_id
repository_id
worktree_id
worktree_path
task_name
idempotency_key
command_fingerprint
source_fingerprint
timeout_ms
state
slot_held boolean
process_id nullable
anchor_pid nullable
created_at
started_at nullable
finished_at nullable
exit_code nullable
signal nullable
error nullable
source_validity UNCHANGED|CHANGED|UNKNOWN
stop_reason nullable CANCELLED|TIMED_OUT|INTERRUPTED
memory_estimate_bytes nullable

unique (scope, idempotency_key)
```

Backs `wtm run <task> --enqueue`; see [the shared finite-task
queue](02-architecture.md#shared-finite-task-queue) for the FIFO/concurrency/memory-budget rules
this table enforces. `heavy_job_state_owner` is a single-row table (`singleton = 1`) binding the
whole database to one machine/user scope before managed-process recovery runs.

### `ci_watches` / `ci_runs`

```text
ci_watches:
  watch_id primary key
  sequence
  repository_id
  worktree_id
  worktree_path
  provider_repo
  branch nullable
  head_sha
  pr nullable
  state pending|success|failure|cancelled|timed_out|no_runs|superseded|unavailable
  detail nullable
  started_at
  updated_at
  finished_at nullable
  next_poll_at
  poll_interval_ms
  failure_streak
  saw_runs boolean

  at most one row per worktree_id with state = pending

ci_runs:
  watch_id references ci_watches(watch_id) on delete cascade
  position
  run_json

  primary key (watch_id, position)
```

Backs `wtm ci watch/status/unwatch`. Like `heavy_jobs`, a watch has no foreign key to `worktrees`:
worktree rows are never deleted, so `wtm remove` deletes a worktree's watches explicitly. Runs
belong to their watch and cascade with it.

### `features` / `feature_creations` / `feature_creation_members`

```text
features:
  id UUID primary key
  workspace_id references workspaces(id) on delete cascade
  branch
  created_at

  unique (workspace_id, branch)

feature_creations:
  id UUID primary key
  feature_id references features(id) on delete cascade
  state IN_PROGRESS|COMPLETED|SUPERSEDED
  from_ref nullable
  created_at
  updated_at
  completed_at nullable

  at most one row per feature_id with state = IN_PROGRESS

feature_creation_members:
  creation_id references feature_creations(id) on delete cascade
  repository_id (no foreign key, see below)
  repository_main_root
  position
  worktree_path
  branch_existed boolean
  start_oid
  phase PLANNED|APPLYING|APPLIED|REGISTERED
  last_error_code nullable
  updated_at

  primary key (creation_id, repository_id)
  unique (creation_id, position)
```

Backs multi-repository `wtm create --repos`. A feature is "one workspace, one full branch ref"
given a durable id; a creation is one attempt at materializing that branch across repositories.
`feature_creation_members.repository_id` has no foreign key on purpose: forgetting a repository
mid-creation must leave the member visible, so `--resume` can refuse by naming it instead of
silently finishing without it.

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

## Resource GC state

`resource_storage_objects.state`:

```text
READY
 -> STALE | ORPHANED   (no longer referenced; set by the resource-production layer)
 -> QUARANTINED         (an applyGcPlan operation holds a cleanup lease on it)
 -> REMOVED             (terminal — content deleted, cleanup lease released)

QUARANTINED -> STALE | ORPHANED   (previous_state, on a lease released before finishing)
```

`resource_gc_journal.phase`, one row per destructive operation:

```text
prepared -> linked -> unlinking -> quarantined -> deleting -> deleted -> finalized
   \                                    ^
    \__________(directories: rename() moves straight here)__________/
```

A file is quarantined by hard-linking it into the sandbox's quarantine container (`linked`), then
unlinking the original (`unlinking`) — two steps so a crash between them still leaves one real
link to the content. A directory cannot be hard-linked, so `prepared` moves straight to
`quarantined` by `rename()`. `deleting`/`deleted` remove the quarantined copy itself;
`finalized` is reached once the now-empty quarantine container is cleaned up and the cleanup lease
released, at which point `resource_storage_objects.state` becomes `REMOVED`.
`recoverGcJournalEntry` resumes an interrupted operation from exactly the `phase` its journal row
last recorded, never by re-probing the filesystem for what state it must be in.

## Process state

```text
STARTING -> RUNNING -> STOPPING -> STOPPED
    \          \
     FAILED     STALE_IDENTITY
```

`STALE_IDENTITY` means the stored PID no longer matches the originally tracked process. WTM drops/repairs the record and never signals the unrelated process.

A run that ends by itself goes to `STOPPED` on exit status 0 and `FAILED` otherwise, and records
`exit_code` or `exit_signal` (migration 019). The daemon prefers the task's own status from the
anchor's `completion.json` over the anchor's exit status, which is derived from it (`128 + n` for a
signal). Recovery after a daemon restart reads the same marker for a run whose process and group
are both gone. Without a marker the end is unknown, and the run is `STOPPED` with neither column
set. A run stopped on request records neither column.

## Heavy job state

```text
QUEUED -> RUNNING -> SUCCEEDED | FAILED | TIMED_OUT | INTERRUPTED

Cancellation, any state before a terminal one:
QUEUED/RUNNING -> CANCELLED
```

`slot_held` tracks concurrency/worktree-exclusion admission independently of `state`: a job keeps
its slot until the daemon proves its complete owned process group or tree is absent, so a `STOPPED`
label or a cancellation request alone never releases it. See [the shared finite-task
queue](02-architecture.md#shared-finite-task-queue).

## CI watch state

```text
pending -> success | failure | cancelled | timed_out | no_runs | unavailable

A new `wtm ci watch` on the same worktree while one is pending:
pending -> superseded
```

Only one `pending` watch may exist per worktree at a time (a unique partial index enforces it); a
newer watch supersedes rather than racing the older one.

## Feature creation state

```text
feature_creations.state:
  IN_PROGRESS -> COMPLETED
  IN_PROGRESS -> SUPERSEDED   (a new `wtm create` restarts the same feature)

feature_creation_members.phase, per member:
  PLANNED -> APPLYING -> APPLIED -> REGISTERED
```

Only one `IN_PROGRESS` creation may exist per feature; `--resume` re-drives each member's own
`phase` rather than the creation's `state`, since members can be at different phases when a
multi-repository `wtm create` is interrupted.

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
