# Multi-repository `wtm create` and creation recovery (todo item 6, remainder)

## Status

Design approved in conversation on 2026-09-13, section by section. Not implemented. This spec
covers the two sub-items the 2026-09-07 create spec
([`2026-09-07-create-worktree.md`](2026-09-07-create-worktree.md)) deferred with reasons:
*multi-repo branch alignment* and *partial multi-repo creation rollback/recovery*.

## Problem

Single-repository `wtm create <branch>` shipped: one `git worktree add`, a computed path, every
refusal decided before Git writes, reconcile through the daemon or locally. Two acceptance
criteria of `todo.md` item 6 remain open:

- *"Multi-repo create aynı feature identity altında çalışıyor."* The data model has no feature.
  The runtime computes a feature on every call as the worktrees of one workspace that share a
  full branch ref (`featureGroup`, `packages/daemon/src/task-resolution.ts`, and its CLI copy
  `featureWorktreeIds`, `packages/cli/src/state-diagnostics.ts`). Endpoints and CORS are shared on
  that basis. Nothing is stored.
- *"Yarım kalan creation güvenli biçimde recover ediliyor."* A creation across N repositories is
  N non-atomic `git worktree add` calls. A failure or crash between them leaves some worktrees
  created and others not, and nothing records which.

Constraints found in the code that shape the design:

- `repository_operation_leases.operation` has `CHECK (operation IN ('remove', 'gc', 'repair'))`
  (migration 010), so a `create` lease needs a table rebuild.
- `withRepositoryOperationLease` releases its row in `finally`, even when the body fails. The row
  is `remove`'s journal, but it cannot be the journal of a creation that is meant to survive a
  failure and be resumed.
- Lease acquisition refuses, never waits, and takes one repository per call. There is no ordered
  acquisition across repositories.
- Lease acquisition calls `assertNoHeavyJobs`, which refuses when the repository has a queued or
  running heavy job. That guard exists for destructive operations.
- `remove --resume` re-runs every stage because each is idempotent. `git worktree add` is not, so
  that rule cannot be reused for an uncertain creation step.
- Repository records have no name. `[repos.<name>]` names a repository by `path`, or by the entry
  name matching the main root's directory name (`resolveRepoScope`,
  `packages/core/src/config/repos.ts`).

## Decisions

These were each chosen over the alternatives listed, in conversation:

1. **Feature identity is "same workspace, same full branch ref", made persistent.** A `features`
   row gives that group a durable id. The runtime's grouping rule does not change, so the stored
   id and the computed group cannot disagree. Rejected: an explicit `feature_id` on worktrees
   allowing different branch names per repository (changes the runtime's grouping rule), and no
   persistent identity (does not meet the acceptance criterion).
2. **A partial creation is left in place and resumed.** Nothing WTM created is deleted
   automatically. `--resume` converges on the requested state and refuses on anything ambiguous.
   Rejected: automatic rollback (a destructive path that would have to go through the removal
   safety chain while hooks may already have run), and resume plus an `--abandon` command (more
   scope than needed now).
3. **Only multi-repository create takes a lease.** Single-repository create stays lease-free, as
   the 2026-09-07 spec decided. Rejected: a lease for every create (single-repo create would start
   refusing behind a running `gc`), and no lease at all (no protection against a concurrent
   `remove` or `gc` in a member repository).
4. **The creation journal lives in its own tables, not in the lease row.** The lease protects
   concurrency and is released when the command ends; the journal survives and `--resume` reads
   it. Rejected: the journal in the lease row (the lease would have to stay held after a failure,
   locking `remove` and `gc` until someone resumes, and one row cannot carry N members' phases),
   and a `CREATING` worktree state (a worktree row exists only after Git and reconcile, so members
   not yet written have nowhere to live).

## Design

### 1. Command and behaviour

```bash
wtm create <branch> --repos web,api,worker [--from <ref>] [--resume] [--json]
```

- Without `--repos`, `wtm create` behaves exactly as today, with no lease.
- `--repos` with a single name still takes the multi-repository path (journal and lease), so the
  behaviour depends on the flag, not on the count.
- **Workspace.** The workspace of the registered worktree containing the working directory; if
  there is none, the registered workspace whose root contains the working directory. Multi-repo
  create can therefore run from the workspace root, which `findRegistration` alone refuses.
- **Repository names.** Each name resolves through a `[repos.<name>]` entry, or else through the
  main root's directory name, using the same rule as `resolveRepoScope`. An unknown name, or a name
  matching more than one repository, is refused with `WTM_CONFIG_INVALID` before anything is
  written. A name given twice counts once.
- **Pre-flight.** The existing pure planner `planWorktreeCreation` runs for every member: branch
  checked out elsewhere (`GIT_BRANCH_IN_USE`), path occupied (`WTM_WORKTREE_PATH_OCCUPIED`), branch
  slug empty or `--from` with an existing branch (`WTM_CONFIG_INVALID`). If any member is refused,
  the whole command is refused, every member's refusals are reported together, and Git writes
  nothing.
- **Pinned start points.** For a new branch, each repository resolves `--from`, or its main
  worktree's HEAD, to a commit OID at plan time, and the OID is journalled. The same branch name
  does not mean the same commit, so each member keeps its own. Where the branch already exists in
  a repository, that member checks it out and records its current OID. A `--from` that does not
  resolve in some member refuses the command.
- **An open creation blocks a new one.** If the feature has an `IN_PROGRESS` creation, `create`
  without `--resume` is refused with `WTM_OPERATION_CONFLICT` and the remediation
  `wtm create <branch> --repos … --resume`. The one exception is in §4.
- **`--json` success envelope** (`command: 'create'`, schema version 1):

  ```text
  data.feature      { id, branch }
  data.members[]    { repository, worktree { path, branch, head },
                      branch { name, created, startPoint }, phase, recoveredFrom? }
  data.registration 'daemon' | 'local'
  data.resumed      boolean
  ```

  A partial failure returns `ok: false` with the failing member's error, and `data.members` still
  shows which members completed.

### 2. Data model: migration 014

- **`features`**: `id TEXT PRIMARY KEY`, `workspace_id` (references `workspaces`,
  `ON DELETE CASCADE`), `branch TEXT NOT NULL` (full ref, e.g. `refs/heads/feat/auth`),
  `created_at`. `UNIQUE (workspace_id, branch)`. Written by multi-repository create only; there is
  no backfill for existing worktrees, and single-repository create does not write it.
- **`feature_creations`**: `id TEXT PRIMARY KEY`, `feature_id` (references `features`,
  `ON DELETE CASCADE`), `state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED',
  'SUPERSEDED'))`, `from_ref TEXT`, `created_at`, `updated_at`, `completed_at`. A partial unique
  index allows one `IN_PROGRESS` row per feature.
- **`feature_creation_members`**: `creation_id` (references `feature_creations`,
  `ON DELETE CASCADE`), `repository_id` (references `repositories`, `ON DELETE CASCADE`),
  `position INTEGER NOT NULL` (lease order), `worktree_path TEXT NOT NULL`,
  `branch_existed INTEGER NOT NULL`, `start_oid TEXT NOT NULL`, `phase TEXT NOT NULL CHECK (phase IN
  ('PLANNED', 'APPLYING', 'APPLIED', 'REGISTERED'))`, `last_error_code TEXT`, `updated_at`.
  `PRIMARY KEY (creation_id, repository_id)`.
- **`repository_operation_leases` is rebuilt** so its `operation` check includes `create`: copy
  into a new table, drop, rename, recreate `idx_repository_operation_lease_expiry`. Every existing
  row, including `host_id` (migration 011), is preserved. This follows the rebuild pattern of
  migrations 007 and 008.
- **Forgetting.** Forgetting a workspace or repository removes its rows by cascade. A resume whose
  journal names a repository that is no longer registered is refused, naming that repository (§4).
- **Retention.** `COMPLETED` and `SUPERSEDED` creations are kept. The rows are small and record
  when and from which commits a feature was created.
- **Store API** (`StateStore`, with TypeScript records in `packages/core/src/state/store.ts`):
  `upsertFeature`, `beginFeatureCreation` (feature, creation and every member in one transaction),
  `advanceCreationMember`, `completeFeatureCreation`, `supersedeFeatureCreation`,
  `readOpenFeatureCreation(workspaceId, branch)`.

### 3. Execution order, leases and heavy jobs

1. **Plan (read-only).** Resolve the workspace and members, read each repository's worktree
   topology and branch refs, pin start OIDs, run pre-flight. Nothing is written.
2. **Leases.** Acquire a `create` lease on each member repository in ascending `repository.id`
   order. If one is refused, release the ones already held in reverse order and fail with
   `WTM_OPERATION_CONFLICT`; never wait. Because every multi-repository create acquires in the same
   order and none waits, two of them cannot deadlock.
   - **Heavy jobs.** The `create` lease skips `assertNoHeavyJobs`: create only adds a worktree, and
     a typecheck queued in another worktree of the repository is no reason to refuse it. `remove`,
     `gc` and `repair` keep the check. Heavy-job admission is unchanged.
   - **Second pre-flight.** With every lease held, pre-flight runs again against a fresh read of
     topology and refs. If anything changed since planning (a branch checked out elsewhere, a path
     filled), the command is refused and nothing is written.
3. **Journal.** Only then, in one transaction: upsert the feature, insert the `IN_PROGRESS`
   creation and one `PLANNED` member per repository. A refused command leaves no journal.
4. **Apply, by `position`.** For each member:
   1. renew every held lease (TTL 120 s, no heartbeat, so a slow checkout does not outlive it);
   2. set the phase to `APPLYING`;
   3. run `git worktree add`, with `-b <branch> <start_oid>` for a new branch, or checking out the
      existing branch;
   4. read the topology back and verify path, branch and, for a new branch, `HEAD = start_oid`;
   5. set the phase to `APPLIED`.

   If Git fails and the topology proves the worktree was not created, the member goes back to
   `PLANNED` with `last_error_code`, later members are not attempted, and the creation stays
   `IN_PROGRESS`. If that proof is not available (for example the process died), the member stays
   `APPLYING` and §4 decides.
5. **Registration.** When every member is `APPLIED`, send the daemon one `reconcile` request, as
   single-repository create does. With no daemon answering, reconcile each repository locally and
   warn `WTM_DAEMON_UNAVAILABLE`. Members whose registration succeeded become `REGISTERED`; when all
   are, the creation becomes `COMPLETED` and the command returns `ok: true`. Hooks and
   `worktree.created` come from the daemon, as today. If registration fails for some members, Git
   is already done: those members stay `APPLIED`, the command returns `GIT_REPOSITORY_DEGRADED`, and
   `--resume` repeats only registration.
6. **End.** Leases are released in `finally` whatever happened. The journal stays.

### 4. `--resume` and recovery

```bash
wtm create <branch> --resume [--repos …] [--json]
```

- **Entry checks.**
  - With no open creation for this workspace and branch, refuse with `WTM_CONFIG_INVALID`: there
    is nothing to resume.
  - A given `--repos` must equal the journal's member set; otherwise refuse, showing both lists.
  - `--from` is refused with `--resume`, because the start points were pinned by the first run.
- **Leases** are acquired in the same order with adoption: an expired lease whose holder is
  provably gone is taken over. A live holder is `WTM_OPERATION_CONFLICT`, meaning another create
  or resume is running.
- **Rule: resume converges on the requested state and refuses on ambiguity.** No phase is re-run
  blindly. For each member, the observed Git state decides, not the recorded phase alone:

  | Observed state | Action |
  | --- | --- |
  | Phase `REGISTERED` | Skip. |
  | A worktree at the planned path on the planned branch | Treat as `APPLIED`, go to registration. Covers `APPLYING` rows that actually completed before a crash. A HEAD that moved past `start_oid` is accepted and reported. |
  | No worktree, path absent, and the branch either absent or (with `branch_existed = 0`) at `start_oid` and checked out nowhere | Safe: apply. A branch at exactly `start_oid` is taken to be the one this creation made before `worktree add` failed, and is checked out. |
  | The member's repository is no longer registered | Refuse, naming the repository. |
  | Anything else: path exists but is not a worktree; a worktree at the path on another branch; the branch at a different OID or checked out elsewhere; a stale (prunable) Git worktree entry | Refuse with `WTM_WORKTREE_PATH_OCCUPIED` or `GIT_BRANCH_IN_USE`, naming what was found, with a concrete remediation such as `git worktree prune`. WTM deletes nothing. |

- **End.** When every member is `APPLIED`, registration runs as in §3 and the creation becomes
  `COMPLETED`. `--json` reports `resumed: true` and each member's `recoveredFrom` phase.
- **Superseding.** If every member of the open creation is still `PLANNED`, Git was never written
  to. A new `create` (without `--resume`) then marks the old creation `SUPERSEDED` and opens its
  own, so changing `--repos` or `--from` after such a failure is never a dead end.
- A user who wants to give up on members that were created removes them with `wtm remove`; a later
  `--resume` would create them again.

## Testing

- **Pure planner (core):** refusals aggregated across members; `--repos` name resolution through
  `[repos.<name>]` and directory names, unknown and ambiguous names refused; start OIDs pinned; a
  `--from` unresolvable in one member refuses all.
- **Recovery classifier:** a pure, table-driven function from (member phase, observed topology and
  refs) to skip / mark applied / apply / refuse(code, found). Every row of the §4 table is a case.
- **Store and migration 014:** the lease table rebuild preserves rows and `host_id`; the check
  accepts `create` and rejects an unknown operation; feature uniqueness; one `IN_PROGRESS` per
  feature; cascades on forget; begin, advance, complete and supersede.
- **Leases:** ascending `repository.id` order; release of already-held leases on a refusal; the
  `create` lease skips the heavy-job check while `remove` still refuses; the second pre-flight
  catches a change between plan and lease.
- **Real-Git CLI scenarios** (in the style of `packages/cli/src/__tests__/create.scenario.ts`):
  - three repositories, with the daemon up and down;
  - a pre-flight refusal writes nothing in any repository;
  - an injected Git failure in the third member leaves two worktrees and the journal, and
    `--resume` completes the feature;
  - a crash in `APPLYING` simulated three ways: worktree created, not created, unexpected leftover
    at the path;
  - a concurrent second create is refused;
  - superseding an all-`PLANNED` creation;
  - `--resume` with a different `--repos` set is refused.

## Documentation

- `docs/04-cli-reference.md`: the `wtm create` section gains `--repos`, `--resume`, the envelope and
  the refusal table; the sentence "Multi-repository creation (`--repos`) is not implemented" goes.
- `docs/18-errors-json-contract.md`: the envelope fields and where each code is used.
- `docs/03-configuration-spec.md`: a note under endpoint sharing per feature that a multi-repository
  create records the feature persistently, without changing the grouping rule.
- `CHANGELOG.md`: `### Added`.
- `todo.md` item 6: the multi-repo sub-items and acceptance criteria.
- `docs/superpowers/specs/2026-09-07-create-worktree.md`: a status note that "`create` takes no
  repository operation lease" now applies to single-repository create only, linking this spec.

## Out of scope

- `--abandon`, or any automatic rollback.
- Completing creations automatically at daemon startup. A creation is a user action, and the
  daemon does not run `git worktree add`.
- A `wtm doctor` finding for open creations.
- A feature-level lifecycle event or a `feature` event subject type.
- Different branch names per repository within one feature.
- A lease for single-repository create.

## Acceptance criteria (from `todo.md` item 6)

- [ ] Multi-repo branch alignment: every member of a multi-repository create uses the same branch
      name with a start commit pinned per repository before any write.
- [ ] Partial multi-repo creation rollback/recovery: a partial creation is journalled per member
      and completed by `--resume`, which never re-runs an uncertain step blindly and refuses on
      ambiguity without deleting anything.
- [ ] Multi-repo create aynı feature identity altında çalışıyor: its members share one persistent
      `features` row, and the runtime's feature grouping is unchanged.
- [ ] Yarım kalan creation güvenli biçimde recover ediliyor: the §4 table, proven by the recovery
      classifier tests and the crash scenarios.

## Plan

To be written with the writing-plans skill after this spec is reviewed:
`docs/superpowers/plans/2026-09-13-multi-repo-create.md`.
