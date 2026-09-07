# Plan — Cleanup candidate ranking

Spec: `docs/superpowers/specs/2026-09-07-cleanup-candidate-ranking.md`

Three tasks in sequence. Task 1 is a prerequisite the ranking cannot be written without, Task 2 is
the ranking itself, Task 3 wires it into the command. Do not start Task 3 before Task 2 is green:
the ordering rules are much cheaper to get right against a pure function than against a spawned
CLI.

## Task 1 — Give the analyze path the state it already stores

Owns: `packages/cli/src/main.ts` (the aggregate analysis path only).

The store is opened today only for `--global` or a numeric selector, and closed in that block's
`finally` before any analysis runs, so the local `--cleanup-candidates` path has no store at all.

1. Read the current lifetime in full before changing it — the `finally { store?.close(); }` is
   deliberate, and the fix is to extend the lifetime, not to remove the close.
2. Open the store for `--cleanup-candidates` as well, readonly, exactly as the existing branch
   does (`new SQLiteStateStore(input.databasePath, { readonly: true })`), and keep the same
   `stateFailure('analyze', …)` behaviour when it cannot be opened.
3. Keep it open across the analysis, and close it once. A worktree with no matching
   `WorktreeRecord` must remain analyzable: an unregistered repository is a supported case on this
   path (that is why `resolveConfiguredAllowedRemoteRefs` walks up rather than requiring a
   registration), so a missing record is data, not an error.
4. Collect per-candidate, for whatever the store knows: the `WorktreeRecord` (`createdAt`,
   `lastSeenAt`, `lastRuntimeAt`) and whether any active managed process belongs to it
   (`listManagedProcesses` / `findActiveManagedProcess`).

Nothing about the output changes in this task. It ends when the data is in hand and the existing
analyze tests still pass.

## Task 2 — The ranking function, in core

Owns: `packages/core/src/analysis/cleanup-ranking.ts` (new) and its tests. Exported from
`packages/core/src/index.ts` alongside the other analysis exports.

1. Define the input as a plain record per candidate: the `WorktreeAnalysis`, plus the optional
   state-derived facts from Task 1 (`lastRuntimeAt`, `hasRunningProcess`, `recordCreatedAt`), plus
   the branch's last commit timestamp. Optional means genuinely optional — the function must be
   callable with none of them.
2. Implement the tier comparison in the spec's order: readiness, nothing-running, work-safely-
   elsewhere (qualified by `remoteKnowledge.source`), idleness, prunable. Compare tiers
   lexicographically; do not sum.
3. Tie-break on `identity.path` with a `codeUnitCompare` equivalent, so the order is total. Copy
   the two-line helper rather than importing across the package boundary — `diagnostics.ts` and
   `resources/gc.ts` each already carry their own for the same reason.
4. Derive `score` from the same tier values by a pure documented function, and build `reason` as
   the ordered list of tier facts that applied. An input that was unavailable appears in `reason`
   as an explicit unknown rather than being omitted.
5. Return `{ rank, score, reason }` per candidate in the shape item 7's example shows, with `rank`
   as the 1-based position after sorting.

### Tests to add

`packages/core/src/analysis/__tests__/cleanup-ranking.test.ts`:

- a `SAFE` candidate ranks above a `REVIEW` one, which ranks above a `BLOCKED` one, and the
  `BLOCKED` one is still present in the result rather than filtered out;
- a candidate with a running managed process ranks below an otherwise identical one without;
- merged-and-remote-persisted ranks above merged-only, which ranks above neither;
- persistence known only from `local-refs` ranks below the same candidate after a fetch
  (`remoteKnowledge.source === 'fetched-refs'`);
- an idle candidate ranks above a recently-active one, and a prunable candidate ranks above an
  otherwise identical present one;
- **the unknown case**: a candidate with no `WorktreeRecord` and no commit timestamp does not
  outrank one that is provably idle and merged, and its `reason` names the unavailable inputs;
- **determinism**: two candidates identical on every tier come back in path order, and running the
  ranking twice over a shuffled input produces the same sequence both times;
- `score` agrees with the order — sorting by score never disagrees with the returned `rank`.

## Task 3 — Wire it into `analyze --cleanup-candidates`

Owns: `packages/cli/src/main.ts` (aggregate envelope assembly), `packages/cli/src/__tests__/`.

1. Apply the ranking to `data.analyses` **in the envelope**, before it is returned. Not in
   `renderEnvelope`, not in a `--json` branch — `packages/cli/src/output.ts` walks the same object
   `--json` serializes, and sorting in the envelope is what makes the third acceptance criterion
   structurally true instead of merely currently true.
2. Attach `rank`, `score` and `reason` to each entry. Decide once whether they sit beside the
   analysis or wrap it, and keep `--all`/`--global` unchanged: they answer different questions and
   the spec leaves them out.
3. Leave `analyze` read-only. No flag added, nothing filtered.

### Tests to add

- `packages/cli/src/__tests__/` — a scenario over a real multi-worktree fixture asserting the
  returned order and that every entry carries `rank`/`score`/`reason`;
- the same scenario asserting the human rendering lists the candidates in the same order as
  `--json`, since that is the acceptance criterion and it must be observed end to end, not assumed
  from `output.ts`'s shape;
- a regression test that `--cleanup-candidates` still excludes the main worktree and still returns
  every linked one, ranked — the filter is not replaced by the ranking.
- `docs/04-cli-reference.md` and `docs/10-git-safety-worktree-analysis.md`'s "Cleanup candidates"
  section — document the tier order, the tie-break, and that `score` is derived from the tiers.
  Item 8 was closed with exactly this gap outstanding; do not repeat it.

## Close-out

- `todo.md` item 7: the ranking-input checklist ships as **seven `[x]` and one `[ ]`** — reclaimable
  disk size stays open with the reason written down (`disk.ts` reports `reclaimable:
  'not-estimated'`; making it a number is a measurement feature, not a ranking one). Flip the three
  acceptance criteria only if all three are genuinely met, and leave the item header `[ ]` while
  the reclaimable line is open, following the convention item 2's `repair` line already uses.
- Full local gate before committing: `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`.
