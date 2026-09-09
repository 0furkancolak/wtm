# Cleanup candidate ranking (todo item 7)

## Status

Open — planned, not started. `todo.md` item 7 states the gap in one line: *"`wtm analyze
--cleanup-candidates` yalnızca linked worktree filtresi olmamalı."* That is exactly what it is
today.

## Problem, with real evidence

`--cleanup-candidates` is a filter and nothing else. Its entire behaviour is one clause in
`packages/cli/src/main.ts`'s aggregate analysis path:

```ts
if (input.all || input.cleanupCandidates) {
  for (const [index, record] of topology.entries()) {
    if (!input.cleanupCandidates || index > 0) selected.push({ repoPath: repositoryRoot, record });
  }
}
```

`index > 0` skips the main worktree. Every other linked worktree is analyzed and returned, in
`listGitWorktrees` topology order, by the aggregate envelope that flattens the per-worktree
envelopes into `data.analyses`. There is no `rank`, no `score`, and no `reason` anywhere in the
codebase — a user asking "which of my fourteen worktrees should I delete first" is handed fourteen
full analyses in the order Git happened to list them, and has to rank them by eye.

### What the ranking inputs cost today

Item 7 names eight inputs. They are not equally available, and the difference decides the shape of
this increment.

**Four are already in `WorktreeAnalysis`** (`packages/core/src/analysis/worktree-analysis.ts`), so
they cost nothing beyond reading a field the command already computes:

| Input | Where |
| --- | --- |
| deletion readiness | `safety.readiness` — `'SAFE' \| 'REVIEW' \| 'BLOCKED'` |
| merged/reachable state | `base.merged`, `base.headIsAncestor`, `base.uniqueCommits` |
| remote persistence | `remotePersistence.persisted`, qualified by `remoteKnowledge.source` |
| prunable state | `identity.prunableReason`, alongside `identity.pathExists` |

**Two are in the state database already**, with no migration needed —
`WorktreeRecord` (`packages/core/src/state/store.ts`) carries `createdAt`, `lastSeenAt` and
**`lastRuntimeAt`**, and `StateStore.listManagedProcesses` answers whether anything is running.
But the analyze path cannot reach them as written: `main.ts` opens the store only

```ts
if (input.global || /^\d+$/.test(input.selector ?? '')) {
```

and closes it in the `finally` of that same block, *before* any analysis runs. The local
`--cleanup-candidates` path — the one this item is about — therefore has no store open at all.
That is a lifetime change, not a new subsystem, but it is a real change and the plan treats it as
one.

**One is cheap but genuinely absent: age.** No timestamp of the branch's own work reaches the
analysis. One `git log -1 --format=%cI` per candidate answers it.

**One does not exist anywhere, and the codebase says so out loud: reclaimable disk size.**
`packages/cli/src/commands/disk.ts` reports its own measurement basis as

```ts
reclaimable: 'not-estimated',
```

and the only "reclaimable" function in core, `reclaimableWorktreeResourcePaths`
(`packages/core/src/resources/removal.ts`), returns **paths**, not bytes. Producing a number means
walking those trees per candidate — a real measurement feature with its own cost, caching and
staleness questions, on a command users run interactively across every worktree at once.

## Decision

### Rank by ordered tiers, not by a weighted sum

The obvious implementation — give each input a weight, add them up, sort by the total — is
rejected. A weight is a tradeoff assertion, and no one can defend the specific numbers: is
"merged" worth thirty points or forty, and is that more or less than "idle for two weeks"? Worse,
a summed score cannot be explained. The `reason` array item 7 asks for (`["SAFE", "merged",
"inactive-14-days", "reclaimable-2.4GB"]`) is a list of *facts*, and a sum cannot say which fact
moved a candidate above another.

So the order is **lexicographic over tiers**, compared in a fixed sequence. Every comparison has a
one-sentence answer: this worktree ranks lower **because** a task is still running in it.

The tier sequence, strongest signal first:

1. **Readiness.** `SAFE` before `REVIEW` before `BLOCKED`. A worktree the safety analysis refuses
   to delete is never a good first suggestion.
2. **Nothing running.** A worktree with no active managed process before one with any. Suggesting
   a developer delete the worktree their dev server is serving from is the fastest way to make the
   whole list untrustworthy.
3. **Work is safely elsewhere.** Remote-persisted *and* merged, before one of the two, before
   neither. Qualified by `remoteKnowledge.source`: persistence known only from stale local refs is
   weaker evidence than persistence confirmed by a fetch, and ranks accordingly.
4. **Idleness.** Longer since the last WTM runtime activity ranks higher, then longer since the
   last commit.
5. **Prunable.** A worktree whose directory Git already reports as gone is the cheapest thing on
   the list to tidy.

### `score` is derived from the tiers, never the thing sorted on

Item 7's example output carries `"score": 92`, so a score has to exist. It is computed as a pure,
documented function of the same tier values the sort uses — so it is reproducible, it agrees with
the order by construction, and it can never drift into being a second, disagreeing opinion. The
sort compares tiers; the score is a rendering of them.

### Unknown is not a good score

`wtm analyze` answers for repositories WTM has never registered — the workspace root is found by
walking up, not by requiring a registration. Such a worktree has no `WorktreeRecord`, therefore no
`lastRuntimeAt` and no managed processes. An absent value must not read as "idle and safe": a
missing input ranks **neutral**, never favourable, and the `reason` array says which inputs were
unavailable rather than silently omitting them. A list that confidently recommends deleting the
worktrees it knows least about is worse than no list.

### Determinism is a total order, in the envelope

Two candidates can tie on every tier. The final comparison is the worktree path under the same
`codeUnitCompare` the diagnostics commands already use for their stable ordering
(`packages/cli/src/diagnostics.ts`), which makes the order total and reproducible.

The sort belongs to `data.analyses` **in the envelope**, never to a renderer. This is what makes
item 7's third acceptance criterion true by construction rather than by discipline:
`renderEnvelope` (`packages/cli/src/output.ts`) is a generic structural walker over the same
`envelope.data` that `--json` serializes, so human and JSON output cannot disagree about order
unless someone sorts at render time. Nobody should, and a test should say so.

### Ranking never deletes, and never hides

`analyze` is read-only and stays read-only; this increment adds no apply path, no `--force`, and no
flag that turns a rank into an action. A `BLOCKED` candidate still appears in the list, ranked
last, carrying its blockers — dropping it would be a policy decision disguised as a sort, and would
hide from the user the one thing they need to see to fix it.

### Scope: seven inputs now, reclaimable size deferred

Wave 1 implements the seven inputs that need no new measurement subsystem. **Reclaimable disk size
is deliberately out of this increment**, because `disk.ts` already declares `reclaimable:
'not-estimated'` and making it a number is a measurement feature, not a ranking feature: it needs
its own decisions about walking cost, caching and staleness before a ranking can honestly consume
it. The tier sequence above is written so that reclaimable size drops in later as an additional
idleness-adjacent tier without reordering anything above it.

`todo.md`'s ranking-input checklist is per-input, so this ships as seven `[x]` and one `[ ]` with
the reason written down — not as a whole item claimed done.

## Acceptance criteria (verbatim from `todo.md`)

- [ ] Çıktı deterministic. — a total order, tie-broken by path; same input, same order, every run.
- [ ] Ranking hiçbir zaman otomatik delete yapmıyor. — no apply path is added, and `BLOCKED`
      candidates stay in the list rather than being filtered out.
- [ ] Human ve JSON output aynı candidate sırasını kullanıyor. — satisfied by sorting
      `data.analyses` in the envelope, which both renderings share.

## Out of scope

- Reclaimable disk size as a number, and any change to `disk.ts`'s `not-estimated` basis.
- Any change to `wtm remove`, the safety analysis, or what `readiness` means.
- A new command. This is `analyze --cleanup-candidates` gaining an order and a reason, nothing more.
- Ranking for `--all` or `--global`, which answer different questions. If the ranking turns out to
  be wanted there, that is a later, separate decision.

## Plan

See `docs/superpowers/plans/2026-09-07-cleanup-candidate-ranking.md`.
