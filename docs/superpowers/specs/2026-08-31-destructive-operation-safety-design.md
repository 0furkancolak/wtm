# Destructive Operation Safety Design

## Status

Implemented — 2026-08-31. Covers Increment A of `docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`,
which is `todo.md` items 1 (runtime-aware `wtm remove`), 2 (cross-process operation leases) and
3 (remote freshness).

This document has been reconciled with what was built. Where implementation and design disagreed,
the code won and the paragraph was rewritten; the rulings behind each change are recorded in
`.superpowers/sdd/2026-08-31-v1-stable/progress.md` and the per-task reports beside it. The user-facing
account now lives in `docs/04-cli-reference.md`, `docs/10-git-safety-worktree-analysis.md` and
`docs/13-data-model-and-state-machines.md`; this remains the design record.

## Objective

Make `wtm remove` do what `docs/10-git-safety-worktree-analysis.md` already promises: stop the
worktree's managed processes, release its runtime resources, and only then let Git delete it — and
make that whole sequence safe when a second CLI process or the daemon tries the same thing at the
same time, and recoverable when the process performing it dies halfway through.

Three failures are in scope:

1. **Orphan processes.** `removeWorktreeSafely` deletes a worktree while its managed processes are
   still running. The daemon's records then point at a directory that no longer exists, and the
   processes keep holding ports.
2. **Unserialized destruction.** The repository mutex is a process-local `Map`
   (`packages/core/src/analysis/remove-worktree.ts:25`). Two `wtm` processes, or the CLI and the
   daemon, do not serialize against each other at all.
3. **Silent staleness.** A branch deleted on the remote still has a local remote-tracking ref, so
   `analyzeRemotePersistence` reports HEAD as remote-persisted and removal proceeds. Nothing in the
   output tells the caller how old that knowledge is.

Out of scope: `wtm create`, cleanup-candidate ranking, the `[git] allowed_remote_refs` config
surface, and any change to which conditions block a removal. The blocker set stays exactly as
`docs/10` defines it, and there is still no `--force`.

## User experience

### Removing a worktree with running tasks

```console
$ wtm remove 7
stopped 2 managed processes
released 2 endpoint leases
removed /Users/dev/project/.worktrees/feat-auth (feat/auth)
```

Stopping is not optional and not a prompt. `wtm remove` is already refused for every unsafe Git
state, so by the time cleanup starts the worktree holds no unsaved work; killing its own managed
processes is the documented behaviour, not a surprise.

### Removing while the daemon is unreachable

```console
$ wtm remove 7
[WTM_DAEMON_UNAVAILABLE] The daemon owns 2 running processes in this worktree and is unreachable.
  Start it with: wtm daemon install
```

Exit code 4. WTM never signals a process the daemon supervises from a second process: the supervisor
holds the child handle, the reservation, and the identity quadruple that makes escalation safe.
A worktree with no active managed process records is removed normally with no daemon.

### A second terminal doing the same thing

```console
$ wtm remove 7
[WTM_OPERATION_CONFLICT] Another wtm process is performing "remove" on this repository.
  holder pid 51422, acquired 2026-08-31T10:14:02.118Z
```

Exit code 3 — this is a safety refusal, in the same class as a Git blocker. WTM does not queue
behind the other process: a destructive operation that waits an unbounded time is worse than one
that tells the caller to look at the other terminal.

### Recovering from a crash mid-cleanup

```console
$ wtm remove 7
[WTM_OPERATION_CONFLICT] A previous "remove" on this repository stopped at stage
  "release-endpoints" and its process (pid 51422) is gone.
  Re-run with: wtm remove 7 --resume
```

`--resume` adopts the abandoned lease and continues from the recorded stage. Every stage is
idempotent, so `--resume` re-running a stage that actually completed is harmless.

### Remote freshness

```console
$ wtm analyze 7 --refresh-remotes
```

`--refresh-remotes` runs `git fetch --prune` for every remote named by an allowed remote-ref
pattern, before analysis, and says so. Default analysis performs no network access; that behaviour
is unchanged. Both `analyze` and `remove` accept the flag.

Analysis JSON gains one additive block:

```json
{
  "remoteKnowledge": {
    "source": "local-refs",
    "refreshed": false,
    "refreshedAt": null,
    "confidence": "LOCAL_ONLY"
  }
}
```

After a refresh, `source` is `"fetched-refs"`, `refreshed` is `true`, `refreshedAt` carries the
fetch completion timestamp, and `confidence` is `"REFRESHED"`. A caller that must not delete work on
stale evidence checks `remoteKnowledge.confidence`.

If the fetch fails, the command fails with `GIT_COMMAND_FAILED`. The user asked for fresh knowledge;
silently continuing on stale refs while reporting `REFRESHED` would be the dangerous outcome, and
silently continuing while reporting `LOCAL_ONLY` would make the flag meaningless.

## Architecture

### Where the lease lives

A new table, following the idioms of `003-managed-process-start-reservations` (primary key is the
resource, so an insert conflict *is* the lock) and `004-managed-process-reservation-leases`
(nullable expiry as ISO-8601 TEXT, compared with plain `<=` against a caller-supplied `now`).

```sql
CREATE TABLE repository_operation_leases (
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  operation           TEXT NOT NULL CHECK (operation IN ('remove', 'gc', 'repair')),
  token               TEXT NOT NULL,
  pid                 INTEGER NOT NULL,
  process_start_time  TEXT NOT NULL,
  subject_worktree_id TEXT,
  stage               TEXT,
  acquired_at         TEXT NOT NULL,
  renewed_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  PRIMARY KEY (repository_id, operation)
);
```

`operation` is in the primary key rather than the table being one-row-per-repository, because a
`gc` and a `remove` on the same repository are not the same conflict; the operations that must
exclude each other declare that in code, not in the schema. V1 declares all three mutually
exclusive per repository, but a later operation can be added without a table rebuild.

`pid` plus `process_start_time` is the identity pair. `process_start_time` is the verbatim
`ps -o lstart=` string, exactly as `managed_processes.process_start_time` already stores it, so the
two subsystems compare identity the same way and a reused PID can never satisfy a stale-recovery
delete.

`stage` and `subject_worktree_id` are what make an interrupted operation recoverable: the row *is*
the journal. A crash leaves a lease whose stage names the last completed step and whose owner is
gone. That is a strictly better signal than a separate journal table, because there is exactly one
row to reason about and it cannot disagree with the lock.

### Store API

`StateStore` gains five methods, all wrapped in `this.transaction(...)`, i.e. `BEGIN IMMEDIATE`:

```ts
acquireRepositoryOperationLease(
  input: RepositoryOperationLeaseRequest,
  now: string,
): RepositoryOperationLeaseResult;
renewRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string, now: string, ttlMs: number): boolean;
advanceRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string, stage: string, now: string): boolean;
releaseRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string): boolean;
readRepositoryOperationLease(key: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null;
```

`readRepositoryOperationLease` was not in the first draft. It is what lets the lease policy measure
a colliding holder's liveness *before* opening the transaction (see below), and it deliberately
returns the holder view, which carries no token: reading a lease must not hand out the capability
to release it.

`advance` is gated on the token, not on expiry. An adopter holds a different token, so the token
check already keeps a displaced owner from writing over its successor's progress — while refusing a
still-working holder's stage write over a lapsed TTL would discard the journal that recovery
depends on.

```ts
type RepositoryOperationLeaseResult =
  | { outcome: 'acquired'; lease: RepositoryOperationLease; adoptedStage: string | null }
  | { outcome: 'conflict'; holder: RepositoryOperationLeaseHolder }
  | { outcome: 'abandoned'; holder: RepositoryOperationLeaseHolder };
```

`adoptedStage` is the stage an adopted lease had reached, and null for a lease taken fresh. It is
reported, not obeyed: `--resume` re-runs the lifecycle from the top, because every stage is
idempotent and the journal records where a process stopped writing, not what it finished doing.

`abandoned` is returned when the existing lease has expired **and** its owner is provably gone. It is
not silently taken over: acquisition with `adopt: true` (the `--resume` path) is what takes it. A
caller that did not ask to resume gets a `WTM_OPERATION_CONFLICT` naming the stage, so a half-done
cleanup is never continued by accident by a caller that does not know one happened.

Liveness is decided by the caller, not by SQL. The store cannot run `ps`, and core must not spawn
one per row. `acquireRepositoryOperationLease` takes an `ownerLiveness` verdict computed by the
caller for the single row it collides with:

```ts
interface RepositoryOperationLeaseRequest {
  repositoryId: string;
  operation: RepositoryOperation;
  token: string;
  pid: number;
  processStartTime: string;
  subjectWorktreeId?: string;
  ttlMs: number;
  adopt?: boolean;
  ownerLiveness?: (holder: RepositoryOperationLeaseHolder) => 'alive' | 'gone';
}
```

The callback runs inside the transaction, but it does not itself run `ps` — it cannot, because
reading a PID's start time is asynchronous and the transaction is not. So the verdict is *measured
before* the transaction, from the row `readRepositoryOperationLease` reports, and handed in
precomputed. The callback's job is the guard: if the row it is asked about is not the row the
verdict was measured from — same pid, same start time, same `acquiredAt` — the verdict says nothing
about this holder, and it answers `alive`. That answer can only cost a retry, whereas a wrong `gone`
would evict a process whose liveness was never checked, which is the exact failure the mechanism
exists to prevent. The acquisition re-measures once and then refuses: a repository whose lease row
keeps changing under it has a live participant.

A missing `ownerLiveness` callback counts as no evidence of life, so an expired lease is reported
`abandoned` rather than `conflict`. The alternative would make a crashed holder's lease
unrecoverable for any caller that cannot run `ps`.

There is deliberately no renewal heartbeat. A lapsed TTL never evicts a live holder, so an operation
that outruns its TTL is already safe; a timer would add a moving part and a second failure mode —
the timer that stops firing under load — that prevents no failure this design has.

`forgetWorkspace` and `forgetRepository` delete from the new table explicitly, matching the existing
comment at `sqlite-store.ts:416-418`: the FK cascade is declared, and the explicit delete is what
the tests assert.

### Process identity in core

Core needs a PID's start time to fill `process_start_time` and to judge a holder's liveness. Today
that lives in `packages/daemon/src/process-supervisor.ts:606`, which core must not import. A new
`packages/core/src/runtime/process-identity.ts` owns the primitive:

```ts
export interface ProcessStartIdentity { pid: number; processStartTime: string }
export async function readProcessStartIdentity(pid: number): Promise<ProcessStartIdentity | null>;
export function installProcessStartIdentityReader(reader: (pid: number) => Promise<string | null>): () => void;
```

It runs `ps -ww -p <pid> -o lstart=` with `LC_ALL=C LANG=C`, a 1 s timeout, a 64 KiB buffer, and
treats exit code 1 with empty output as absence — the same rules as `launchd.ts:2189`. A reader that
cannot answer for any other reason throws rather than guessing, because a wrong `null` releases
somebody else's lease. The installer returns a restore function, so an installation cannot leak past
the test that made it; the seam exists for tests and for the platform abstraction of Increment C,
which will replace the `ps` implementation per platform without touching the lease logic.

The daemon keeps its richer four-field identity. This is deliberately the narrow pair: a lease owner
is a `wtm` process, not a supervised task, and PID + start time is what distinguishes it.

### The remove lifecycle

`removeWorktreeSafely` currently owns analysis, the mutex, and the `git worktree remove` call. It
grows a coordinator port so that core keeps owning the *order* of the lifecycle while the CLI owns
the daemon connection. Core does not learn what a daemon is.

```ts
export interface RemovalRuntimeCoordinator {
  reclaimablePaths(subject: RemovalSubject): Promise<readonly string[]>;
  stopManagedProcesses(subject: RemovalSubject): Promise<StoppedProcessesReport>;
  verifyManagedProcessesStopped(subject: RemovalSubject): Promise<ManagedProcessResidue>;
  cleanupEphemeralResources(subject: RemovalSubject): Promise<EphemeralCleanupReport>;
  releaseEndpointLeases(subject: RemovalSubject): Promise<EndpointReleaseReport>;
  reconcile(subject: RemovalSubject): Promise<void>;
}
```

`RemovalSubject` is `{ repositoryId, worktreeId, worktreePath }`. Every method is idempotent, so
`--resume` can re-enter at any stage. A coordinator method that cannot complete throws; the
lifecycle then stops before Git and leaves the lease at the last completed stage.

`reclaimablePaths` is not a stage. It answers one question the first gate has to ask before it can
refuse — which paths inside the worktree is the cleanup stage about to collect — and it exists
because core deliberately does not know what a resource is. See "The first gate and the content
cleanup owns" below.

The full order, each arrow a recorded stage:

```text
acquire operation lease
    ↓ analyze
analyze Git safety  ──────────────► blocked by anything cleanup does not own
    │                                → release lease, report blockers
    │                               (a GIT_UNTRACKED blocker naming only
    │                                reclaimable paths is deferred and falls through)
    ↓ stop-processes
stop WTM-managed processes
    ↓ verify-processes
verify no active managed process records remain
    ↓ cleanup-resources
cleanup ephemeral runtime resources
    ↓ release-endpoints
release endpoint leases
    ↓ reanalyze
re-analyze Git safety + verify identity unchanged
    ↓ git-remove
git worktree remove --
    ↓ reconcile
reconcile state (daemon emits worktree.removed)
    ↓
release operation lease
```

Three properties of that order are load-bearing and must be tested as such:

- The **second** analysis is the one that gates `git worktree remove`, and it happens *after*
  cleanup. Stopping a dev server can write a build artifact or a log file into the worktree; a
  removal that passed its safety check before that write and deleted afterwards would delete an
  untracked file. The re-analysis is not a formality, it is the check that covers cleanup's own
  side effects. It is also unconditional: nothing the first gate deferred can weaken it.
- Cleanup failure means no Git deletion. There is no partial success in which the worktree is gone
  but its ports are still leased.
- The **first** gate refuses on everything except the untracked content the cleanup stage owns.
  Getting this wrong made the cleanup stage unreachable in production; see below.

### The first gate and the content cleanup owns

The first draft of this design said what the cleanup stage is for and never said what the *first*
gate should do about the content that stage owns. That silence is the whole of the defect: the gate
did the only thing it could and refused, so `cleanup-resources` — the stage built to delete exactly
that content — could never be reached, and `collectedResources` could only ever be `0`.

The rule, stated: at stage `analyze`, a blocker is **deferred** to `cleanup-resources` when its code
is `GIT_UNTRACKED` **and every** path it names resolves inside a path `reclaimablePaths` reported.
Anything else refuses with the same `WorktreeRemovalBlockedError` and the same blocker objects the
analysis produced, before anything is stopped or deleted.

Two invariants keep the deferral from becoming a bypass:

- **Per-blocker, and all-or-nothing.** One `GIT_UNTRACKED` blocker naming a reclaimable directory
  and one real untracked file together is not deferred. Half a match is no match.
- **The second gate stays unconditional.** Deferral authorizes nothing; it moves the decision to
  stage `reanalyze`, which sees whatever cleanup actually left behind. A target cleanup retained
  rather than deleted still refuses the removal, after the processes were stopped but with the
  worktree intact.

The code check is not redundant with the path check. `GIT_DIRTY_STAGED`, `GIT_DIRTY_UNSTAGED` and
`GIT_UNMERGED` carry their paths through the same helper, so without it an edit to a *tracked* file
that happens to live under a declared resource path would be deferred — and deferring it authorizes
deleting work Git could not give back.

Everything fails closed. A blocker whose `context.paths` is absent, empty, or holds a non-string is
not deferrable; a worktree whose configuration cannot be resolved reports no reclaimable paths, so
it refuses at the first gate rather than entering a cleanup that cannot know what to collect;
and `reclaimablePaths` and `cleanupEphemeralResources` read one plan rather than two copies of the
policy set, so the first cannot promise a path the second declines to collect.

`GuardedRemovalResult` gains `deferredBlockers: readonly WtmError[]` — the blockers the first gate
handed to the cleanup stage, exactly as the analysis raised them, empty on the Git-only path. Not
`warnings`: a worktree that ever ran a task is *expected* to hold the directories WTM put there, so
warning on every such removal would train the reader to ignore the warning. But recording nothing
leaves no way to tell a deferral from a worktree that was clean all along, which is the ambiguity
that hid the defect. It is deliberately not added to the CLI's `--json` envelope, which already
reports the same event in its own vocabulary (`cleanup.collectedResources`,
`cleanup.retainedResources`); error-shaped items inside a *successful* envelope's `data` would be a
new schema shape.

The existing in-process mutex stays. It is not redundant: the DB lease refuses a conflicting
operation, while the mutex makes concurrent calls *inside one process* queue rather than fail, which
is what the daemon's own call sites need. The lease is acquired inside the mutex.

### Why the daemon stops the processes

The supervisor owns the child handle, the start reservation, and the identity quadruple, and its
stop path re-verifies identity between SIGTERM and SIGKILL (`process-supervisor.ts:493-506`). A
second process signalling the same group would race that logic with no way to observe it. So the CLI
coordinator implementation sends the existing `stop` IPC command with the worktree path as `cwd`,
and the daemon's `#serialize` lock does the rest.

The consequence is the fail-closed rule stated in the UX section: active managed process records
plus an unreachable daemon equals refusal, not a best-effort kill.

`verifyManagedProcessesStopped` then re-reads the state DB directly and requires zero records in
`STARTING | RUNNING | STOPPING` and zero with `cleanup_required = 1` for the worktree. It trusts the
database, not the stop response, because a durable-cleanup-ownership failure
(`DurableCleanupOwnershipError`) is exactly the case where the response looks finished and the
record says otherwise.

### Endpoint lease release

`endpoint_leases` are released today only as a side effect of `reconcileWorktrees`
(`sqlite-store.ts:373-375`). Removal needs an explicit, verifiable release before Git runs, so
`StateStore` gains:

```ts
releaseEndpointLeasesForWorktree(worktreeId: string, releasedAt: string): number;
```

It flips every `ACTIVE` lease for the worktree to `RELEASED` and returns the count, inside one
transaction. The reconcile-driven release stays exactly as it is; the two paths are idempotent with
respect to each other.

### Ephemeral resource cleanup

The first draft of this section described collecting the worktree's storage objects through the
journaled GC path. That is wrong, and the reason is worth recording, because it changes what this
stage is for.

`wtm gc` must never walk a Git working tree, so a worktree is deliberately never a resource sandbox
and its `[resources]` entries deliberately carry no `resource_storage_objects` row — the comment at
`packages/cli/src/commands/resource-production.ts:41-48` states this outright, and it is why
`wtm disk` had to measure worktree resources separately. Nothing in production ever calls
`registerResourceStorageObject` or `addResourceReference`. Scoping the GC evidence set to a worktree
would therefore have selected nothing, forever, while looking like it worked.

What actually needs cleaning is the opposite thing: the content WTM itself materialized *inside* the
worktree. A `[resources]` entry with policy `isolated` or `ephemeral` is a directory WTM created in
the worktree; to Git it is untracked content, which is a removal blocker. So without this stage a
worktree that ever ran a task cannot be removed at all — the tool's own bookkeeping blocks it. This
stage is what makes removal possible, not merely tidy, and the first gate has to know that: see
"The first gate and the content cleanup owns" above.

`cleanupWorktreeEphemeralResources` deletes exactly the paths the worktree's own resolved
`[resources]` configuration declares, and only for policies WTM creates and owns:

```text
deleted:  isolated  ephemeral  clone  copy  symlink
retained: shared  native-cache  external  ignore
```

The two lists are the whole of `[resources].policy`. An earlier draft also listed `generated`, which
the configuration schema does not define; it is left out rather than cast in. Anything unlisted is
retained, so a policy added later is never deleted by a rule written before it existed.

Every target passes the same authorization `preparation.ts` already applies when it *creates* these
paths — resolved inside the worktree, no `.git` path component, no symlinked or foreign-uid or
group-writable ancestor, and not Git-tracked, with tracked-ness failing closed to "tracked". Deletion
reuses that guard rather than restating it: a path WTM refused to create is a path it must refuse to
delete.

Retained resources are reported with their reason, so `wtm remove --json` says what survived and why.
A shared `node_modules` outliving one worktree is correct behaviour, not an omission.

Two consequences follow from where this stage sits. It runs *before* the second analysis, so the
untracked content it removes is gone by the time the check that gates Git runs — that is the whole
point. And it must be idempotent, because `--resume` re-runs it: a target that is already absent is
a success, not an error.

A declaration whose path cannot be rendered — `{port.api}` after the lease was released, say — is
*retained* with the template error as its reason rather than throwing. Throwing would make such a
worktree permanently unremovable, which is the exact failure this stage exists to fix. The same
declaration is also omitted from `reclaimablePaths`, so the removal refuses at the first gate
instead: omission is always the safe direction, because it refuses.

An unresolvable runtime — an unreadable `wtm.toml`, a registration that has drifted — is a warning
from this stage rather than a refusal, for the same reason. A configuration WTM cannot read is not
evidence that WTM created anything, and whatever is actually in the directory is still Git's to
object to at stage `reanalyze`. An authorization refusal from `cleanupWorktreeEphemeralResources`
itself still propagates and aborts the removal.

## Error contract

One new code in `packages/protocol/src/errors.ts`, the scope/config family:

```text
WTM_OPERATION_CONFLICT
```

Exit code 3 (safety policy), added to the class list in `packages/cli/src/main.ts` and to
`docs/18-errors-json-contract.md`. Context is `{ repositoryId, operation, holderPid, acquiredAt,
stage, abandoned }`; `stage` is null for a live holder. `remediation` carries the `--resume`
suggestion only when `abandoned` is true.

While `docs/18` is being edited, the three daemon codes it already omits
(`WTM_DAEMON_INVALID_REQUEST`, `WTM_DAEMON_PROTOCOL_INCOMPATIBLE`, `WTM_DAEMON_REQUEST_FAILED`) are
added, and a test asserts the document and the enum agree, so the next code cannot drift.

`WorktreeRemovalBlockedError.code` was `'WTM_REMOVE_BLOCKED'`, which is not a member of the enum. It
was never serialized because the CLI unwraps `.blockers`, but it would have failed envelope
validation if it had ever reached one. It is now `reason: 'worktree-removal-blocked'`, a non-code
field, since this increment adds new throw sites on the same path.

Two other codes carry the new refusals rather than being invented:

- `ManagedProcessResidueError` — records that outlived their stop — reuses `RUNTIME_STOP_FAILED`
  and passes its counts through in `context`, so the CLI reports them instead of flattening the
  whole thing to `GIT_REPOSITORY_DEGRADED`. It keeps exit code **1**, not 3: the code is shared with
  `wtm stop`, where it is a runtime failure rather than a safety refusal, and promoting the class
  would change `wtm stop`'s exit code as a side effect.
- A worktree with live managed process records and no reachable daemon refuses with the existing
  `WTM_DAEMON_UNAVAILABLE`, exit **4**, carrying a `wtm daemon install` remediation. A daemon that
  answers the stop and reports a failure keeps the daemon's *own* code, so `wtm remove` says the
  same thing about a stale process identity that `wtm stop` does.

`knownCodes` in `packages/cli/src/commands/git-error.ts` had drifted four codes behind the protocol
enum, `WTM_OPERATION_CONFLICT` among them — which would have flattened the conflict to
`GIT_REPOSITORY_DEGRADED` and made it un-mappable to exit 3. That set is now exactly the enum, and
`toGitSafetyError` carries well-formed `remediation` entries through instead of dropping them.

## JSON contract

Additive only. `WorktreeAnalysis` gains `remoteKnowledge`. `remove`'s success payload gains a
`cleanup` block:

```json
{
  "removed": { "path": "…", "branchRef": "refs/heads/feat/auth", "headOid": "…" },
  "cleanup": {
    "stoppedProcesses": 2,
    "releasedEndpoints": 2,
    "collectedResources": 1,
    "retainedResources": [{ "name": "node_modules", "reason": "shared" }]
  },
  "analysis": { "…": "…" }
}
```

Existing keys keep their meaning and position in the schema. The `cleanup` block is always present
and zeroed rather than omitted — including on the Git-only path a worktree WTM has no registration
for takes — so its shape never varies.

A blocked removal now also carries the analysis warnings it used to drop. Not, as the first draft
had it, by populating the warnings array before the safety check: since the lifecycle moved into
core, the analysis never leaves it and `WorktreeRemovalBlockedError` carries only `.blockers`. The
blocked path instead re-runs `analyzeWorktree` once, read-only, purely for its warnings, and falls
back to none if even that fails. Analysing in the CLI first would have added a third analysis to the
happy path and done it outside the repository lock.

`--refresh-remotes` fetches once per **distinct repository**, before any analysis. The aggregate
modes analyze many worktrees that share one repository, so a refresh hung off the per-worktree
analysis would multiply one honest fetch round by the number of worktrees. The refreshed remote
names are printed as human prose above the envelope and deliberately do not become a new envelope
key, so `--json` stdout still parses as exactly one envelope.

`--resume` on `wtm remove` sets `adopt: true` on the lease acquisition. The conflict a dead holder
produces carries a `--resume` remediation with the selector the caller actually typed, which core
cannot know; a live holder gets no suggestion.

## Testing

Every acceptance criterion in `todo.md` items 1–3 becomes a named test. The ones that need
out-of-process fixtures follow the existing `*.scenario.ts` + `spawnSync('node', ['--import','tsx'])`
convention:

| Behaviour | Kind |
|---|---|
| Running managed process is stopped before Git deletion, no orphan remains | daemon integration |
| Cleanup failure aborts before `git worktree remove`, worktree intact | core, injected coordinator |
| HEAD changed between the two analyses blocks removal | existing TOCTOU test, extended past cleanup |
| Two CLI processes removing concurrently: one wins, one gets `WTM_OPERATION_CONFLICT` | scenario, two children |
| CLI and daemon contending for the same repository | scenario |
| Crash mid-cleanup leaves an adoptable lease; `--resume` completes it | scenario, child killed at a stage |
| Live holder's lease is never stolen, even past its TTL | store test |
| Reused PID cannot pass stale recovery | store test, injected identity reader |
| Endpoint leases are released and the ports become allocatable again | store + CLI test |
| Deleted remote branch is caught by `--refresh-remotes` and missed without it | git fixture |
| Default analysis performs no network access | scenario with a failing `git fetch` on PATH |
| `remoteKnowledge` distinguishes local-only from refreshed | CLI test |
| Both SQLite drivers agree on every new store method | `database-contract` scenario |

## Mechanical checklist

- `packages/core/src/state/migrations/010-repository-operation-leases.sql`
- `packages/core/src/state/assets.ts` — the hardcoded file list
- `packages/cli/src/sea-assets.ts` — the standalone build embeds migrations under a *second*
  hardcoded key list; `scripts/__tests__/build-sea.test.ts` pins it
- `packages/core/src/state/__tests__/assets.test.ts` — the exact list assertion
- `packages/core/src/state/__tests__/sqlite-store.test.ts` — `migrationVersions: [1..9]` becomes `[1..10]`
- `packages/core/src/state/store.ts` + `index.ts` — new contracts and type exports
- `packages/core/src/state/__tests__/database-contract.scenario.ts` — both drivers
- `packages/protocol/src/errors.ts` + `docs/18-errors-json-contract.md` + `errors.test.ts`
- `packages/cli/src/main.ts` — `remove` joins the daemon-client command list; the store opens
  read-write for `remove`; exit-code class for the new code
- `docs/04-cli-reference.md`, `docs/10-git-safety-worktree-analysis.md`, `skills/wtm/SKILL.md`
