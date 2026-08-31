# Git Safety and Advanced Worktree Analysis

## Purpose

WTM should make it easy to create many worktrees without making it easy to lose work.

`wtm analyze` is therefore a first-class feature, not a debug afterthought.

## Analysis dimensions

For every worktree, collect:

### Identity and topology

- workspace;
- repository ID/path;
- main vs linked worktree;
- worktree persistent ID;
- branch ref or detached HEAD;
- HEAD commit;
- lock/prunable annotations from Git;
- worktree path existence;
- configured default/base branch.

### Working tree state

Use porcelain output suitable for machine parsing, including untracked files.

Classify:

```text
clean
staged
unstaged
untracked
unmerged
```

Counts and representative paths can be returned; JSON can include the full parsed set when requested.

### Upstream and remote safety

Determine:

- configured upstream;
- ahead/behind counts;
- whether HEAD is contained in an allowed remote-tracking ref;
- whether a branch has local-only commits;
- whether upstream is missing;
- whether the remote ref is stale/unavailable.

WTM performs local ref analysis by default. `git fetch` is not silently run as part of analysis because network operations can be slow or surprising. `--refresh-remotes` on `analyze` and `remove` fetches first; see [Remote freshness](#remote-freshness).

### Merge/base relationship

Determine:

- commits unique from configured base branch;
- whether HEAD is already an ancestor of the base;
- whether branch tip is merged locally;
- divergence from base;
- detached HEAD reachability.

### Runtime and storage

- WTM-managed processes;
- allocated endpoints;
- Docker/runtime namespace;
- owned storage resources;
- logical/reclaimable size estimate;
- last runtime use;
- cleanup state.

### Freshness

- last commit timestamp;
- last WTM activity;
- worktree age;
- whether Git marks it prunable.

## Analysis result

Each worktree gets a deletion readiness classification:

```text
SAFE
REVIEW
BLOCKED
```

`SAFE` means WTM can remove it without known source-loss risk according to configured policy.

`REVIEW` is informational for states such as stale remote knowledge or detached history that is reachable but unusual.

`BLOCKED` prevents `wtm remove`.

## Mandatory deletion blockers

V1 blocks removal when any of these are true:

1. main worktree;
2. Git worktree is locked;
3. staged changes exist;
4. unstaged tracked changes exist;
5. untracked or Git-ignored files exist;
6. unresolved/unmerged paths exist;
7. submodule state is dirty where Git reports it;
8. branch has commits not safely represented on an allowed remote-tracking ref;
9. detached HEAD contains commits not safely represented on an allowed remote-tracking ref;
10. upstream/ref analysis is internally inconsistent or Git reports repository corruption.

An ignored file blocks removal for the same reason an untracked one does: Git cannot give it
back, and a `.env` or a local database is exactly the kind of thing `.gitignore` names.

A **symbolic link** is the one exception. It holds no content of its own: removing the worktree
removes the link, and what it points at is somewhere else and survives — and if that somewhere
is inside this worktree, it is reported in its own right. Without the exception WTM blocked
itself, because a `[resources]` table that links a worktree's `.env` at the main working tree's
meant no worktree a task had ever run in could be removed.

## "Unpushed" definition

The simplest useful check is not merely "ahead of upstream" because a branch may have no upstream or a commit may be reachable from a different remote branch.

WTM defines a commit as **remote-persisted** when HEAD is reachable from at least one allowed remote-tracking ref according to local Git refs.

Default allowed remotes are `refs/remotes/origin/*`; configuration may expand/restrict this.

If the developer expects fresh remote state, they run `wtm analyze --refresh-remotes` or fetch
themselves first. The analysis reports which of the two happened; see
[Remote freshness](#remote-freshness).

## Remote freshness

Every analysis carries a `remoteKnowledge` block that qualifies `remotePersistence`:

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

After `--refresh-remotes`, `source` is `"fetched-refs"`, `refreshed` is `true`, `refreshedAt`
carries the completion timestamp of the fetch, and `confidence` is `"REFRESHED"`. A caller that
must not delete work on stale evidence checks `confidence` rather than assuming.

The block reports what the *caller* did and nothing else. `analyzeWorktree` has no branch that can
reach the network: the refresh is a separate call the CLI makes before analysis, and its completion
timestamp is handed in. That is a structural guarantee rather than a careful one — there is no
analysis path, aggregate or otherwise, that can be made to fetch.

The refresh runs `git fetch --prune` once per remote an allowed remote-ref pattern selects, and
`--prune` is the load-bearing half. Without it, a branch deleted on the remote leaves its
remote-tracking ref sitting in the local repository; `origin/feat/auth` still exists, HEAD is still
reachable from it, the worktree still looks remote-persisted, and the refresh would report
`REFRESHED` over knowledge exactly as stale as before. The flag would catch nothing, which is worse
than not having it.

Patterns select remotes rather than the other way round: the segment after `refs/remotes/` names
the remote, a trailing `*` in that segment means every configured remote, and the result is
intersected with `git remote`. A pattern naming a remote this repository does not have fetches
nothing, instead of failing on `git fetch upstream` or — much worse — degenerating into a bare
`git fetch` against whatever the default remote is.

A failing fetch fails the command with `GIT_COMMAND_FAILED` and no analysis is reported. The two
alternatives are both dangerous: continuing on stale refs while reporting `REFRESHED` lies to the
caller that asked for fresh evidence, and continuing while reporting `LOCAL_ONLY` makes the flag
meaningless.

## Safe remove flow

The removal lifecycle is eight stages. Each is journalled on the repository operation lease as it
is entered, so a removal whose process dies leaves behind the name of the stage it died in — see
[`repository_operation_leases`](13-data-model-and-state-machines.md#repository_operation_leases).

```text
wtm remove 7
   │
   ▼
acquire the repository "remove" operation lease
   │
   ▼
1. analyze            ── blocked, and cleanup does not own it ──► refuse, change nothing
   │
   ▼
2. stop-processes     the daemon stops this worktree's managed tasks
   │
   ▼
3. verify-processes   the state DB, not the stop response, says they are gone
   │
   ▼
4. cleanup-resources  delete what WTM materialized inside the worktree
   │
   ▼
5. release-endpoints  ACTIVE endpoint leases → RELEASED
   │
   ▼
6. reanalyze          ── blocked ──► refuse; the worktree is intact
   │                  identity unchanged since stage 1?
   ▼
7. git-remove         git worktree remove -- <path>
   │
   ▼
8. reconcile          registrations re-read; the daemon emits worktree.removed
   │
   ▼
release the operation lease
```

Three properties of that order are load-bearing rather than incidental.

**The daemon stops the processes, not the CLI.** The supervisor holds the child handle, the start
reservation, and the process identity its escalation ladder re-verifies between `SIGTERM` and
`SIGKILL`. A second process signalling the same group would race that logic with no way to observe
what it broke, so stage 2 is a `stop` request over IPC and nothing more. The consequence is a
fail-closed rule: a worktree with live managed process records and an unreachable daemon is refused
with `WTM_DAEMON_UNAVAILABLE`, not killed on a best-effort basis. A worktree with no such records
needs no daemon and is removed without one.

**Stage 3 reads the database, not the answer to stage 2.** A durable-cleanup-ownership failure is
exactly the case where the stop response looks finished and the record disagrees, and the record is
the thing that outlives this process. Any record left in `STARTING`, `RUNNING` or `STOPPING`, or any
record still owing durable cleanup, refuses the removal with `RUNTIME_STOP_FAILED` — the worktree
survives and the counts are in the error's context.

**The second analysis is the one that authorizes the deletion, and it runs after cleanup.**
Stopping a dev server can flush a log line or a build artifact into the worktree; a removal that
passed its safety check before that write and deleted afterwards would delete an untracked file
nobody agreed to lose. Stage 6 is therefore not a formality — it is the check that covers the
lifecycle's own side effects — and it also compares the worktree identity (path, HEAD, branch ref,
detached, main) against stage 1, which closes the window in which someone else moved HEAD. Stage 6
is unconditional: nothing stages 1–5 decided can weaken it.

Cleanup failure means no Git deletion. There is no partial success in which the worktree is gone
but its ports are still leased.

### The first gate defers what cleanup owns

Stage 1 exists to fail fast: a worktree holding real uncommitted work should be refused before
anything is stopped or deleted. But it must not refuse over content WTM itself put there.

A `[resources]` entry with policy `isolated`, `ephemeral`, `clone`, `copy` or `symlink` is
something WTM materialized inside the worktree, and to Git it is untracked content — a removal
blocker. Refusing on it at stage 1 makes stage 4, the stage whose entire job is deleting exactly
those directories, unreachable: a worktree that ever ran a task could never be removed, because the
tool's own bookkeeping blocked it. That is not a hypothetical; it was the behaviour, and
`collectedResources` could only ever report `0`.

So stage 1 partitions the blockers before it refuses. A blocker is **deferred** to stage 4 when
both of these hold:

1. its code is `GIT_UNTRACKED`, and
2. **every** path it names resolves inside a path the cleanup stage says it is about to collect.

Everything else refuses, exactly as before. The rule is deliberately narrow in three directions,
and each narrowing is what keeps it safe:

- **Per-blocker and all-or-nothing.** A single `GIT_UNTRACKED` blocker naming one reclaimable
  directory and one real file is not deferred. Half a match is no match.
- **Code-checked, not only path-checked.** `GIT_DIRTY_STAGED`, `GIT_DIRTY_UNSTAGED` and
  `GIT_UNMERGED` carry paths through the same machinery, so without the code check an edit to a
  *tracked* file that happens to live under a declared resource path would be deferred — and
  deferring it authorizes deleting work Git could not give back.
- **Failing closed.** A blocker whose path list is missing, empty, or holds anything that is not a
  string is not deferrable. An untracked blocker WTM cannot read the extent of is one it cannot
  prove is harmless. Likewise, a worktree whose configuration WTM cannot resolve reports no
  reclaimable paths at all, so it refuses at stage 1 rather than entering a cleanup that does not
  know what to collect.

Deferring authorizes nothing. It moves the decision to stage 6, which sees whatever cleanup
actually left behind: if stage 4 retains a target instead of deleting it, the untracked content is
still there and the removal is refused — after the processes were stopped, but with the worktree
intact.

The deferred blockers are reported on the removal result as `deferredBlockers`, exactly as the
analysis raised them. They are not warnings: a worktree that ran a task is *expected* to hold the
directories WTM put there, and warning on every such removal would train the reader to ignore the
warning. But a result that says nothing at all leaves no way to tell a deferral from a worktree
that was clean all along, and that ambiguity is precisely what hid the defect behind
`collectedResources: 0`.

### Serializing two removals

`wtm remove` takes a `remove` lease on the repository before stage 1 and holds it to the end. A
second process asking for the same repository is refused with `WTM_OPERATION_CONFLICT` (exit 3)
naming the holder, rather than queued: a destructive command that waits an unbounded time behind
another one is harder to reason about than one that tells you which terminal to look at.

A lease whose TTL lapsed is not thereby free. It is reclaimable only when its owner is *provably*
gone — the PID has no process, or the process at that PID started at a different time and is a
recycled number wearing a dead holder's identity. Even then the lease is reported rather than
taken: continuing a half-finished cleanup is only safe for a caller that asked to, which is what
`wtm remove <selector> --resume` says. See
[`repository_operation_leases`](13-data-model-and-state-machines.md#repository_operation_leases).

An in-process mutex still sits outside the lease, and is not redundant with it. The mutex makes two
callers *inside one process* queue, which is what the daemon's own call sites need; the lease makes
callers in other processes fail fast. The lease is taken inside the mutex, so a queued in-process
caller does not burn its turn on a refusal.

## No `--force` bypass in V1

WTM does not expose a high-level force flag that ignores these blockers.

The user can resolve the state explicitly:

- commit changes;
- push commits;
- manually revert/reset/clean if they intentionally want to discard;
- unlock the worktree;
- repair Git state.

Then rerun `wtm remove`.

This deliberately makes destructive intent visible.

## Suggested remediation output

The refusal itself has no error code. What reaches `errors[]` is the blockers, each carrying its
own code from [JSON analysis](#json-analysis); the exception that raised them carries
`reason: 'worktree-removal-blocked'` and nothing else. Earlier drafts of this document showed a
`WTM_REMOVE_BLOCKED` code here, which was never a member of the protocol enum and would have failed
envelope validation had it ever been serialized.

A blocked removal also reports the analysis warnings — a missing base ref, a gone upstream — which
are exactly what the reader needs when working out *why* it was refused.

Example:

```text
remove: failed

Worktree: #7 feat/auth

1. Uncommitted changes
   staged: 2
   unstaged: 1
   untracked: 3

   Inspect:
     git -C /path/to/wt7 status

2. Local-only commits
   HEAD is not reachable from an allowed remote ref.

   Typical publish command:
     git -C /path/to/wt7 push -u origin HEAD

WTM did not modify Git state.
```

## Cleanup candidates

```bash
wtm analyze --cleanup-candidates
```

ranks non-running linked worktrees by safe cleanup usefulness using:

- deletion readiness;
- age;
- merged/reachable status;
- disk reclaimable estimate;
- recent WTM activity.

This ranking is advisory; WTM never bulk-removes worktrees without explicit selectors/confirmation.

## JSON analysis

JSON includes a stable `safety.blockers[]` array with machine codes so AI agents do not parse human text.

Example codes:

```text
GIT_DIRTY_STAGED
GIT_DIRTY_UNSTAGED
GIT_UNTRACKED
GIT_UNMERGED
GIT_HEAD_NOT_REMOTE_PERSISTED
GIT_WORKTREE_LOCKED
GIT_MAIN_WORKTREE
```
