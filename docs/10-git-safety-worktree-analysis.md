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

WTM performs local ref analysis by default. `git fetch` is not silently run as part of analysis because network operations can be slow or surprising. A future explicit `--refresh-remotes` can fetch before analysis.

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
5. untracked files exist;
6. unresolved/unmerged paths exist;
7. submodule state is dirty where Git reports it;
8. branch has commits not safely represented on an allowed remote-tracking ref;
9. detached HEAD contains commits not safely represented on an allowed remote-tracking ref;
10. upstream/ref analysis is internally inconsistent or Git reports repository corruption.

## "Unpushed" definition

The simplest useful check is not merely "ahead of upstream" because a branch may have no upstream or a commit may be reachable from a different remote branch.

WTM defines a commit as **remote-persisted** when HEAD is reachable from at least one allowed remote-tracking ref according to local Git refs.

Default allowed remotes can include `origin/*`; configuration may expand/restrict this.

If the developer expects fresh remote state, they should run `git fetch` or an explicit future WTM refresh command first.

## Safe remove flow

```text
wtm remove 7
   │
   ▼
analyze
   │
   ├─ dirty? ---------------------- BLOCK
   ├─ untracked? ------------------ BLOCK
   ├─ unmerged? ------------------- BLOCK
   ├─ not remote-persisted? ------- BLOCK
   ├─ locked/main? ---------------- BLOCK
   │
   ▼
stop WTM-managed processes
   │
   ▼
release/cleanup ephemeral runtime
   │
   ▼
git worktree remove <path>
   │
   ▼
reconcile + retained-resource report
```

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

Example:

```text
WTM_REMOVE_BLOCKED

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
