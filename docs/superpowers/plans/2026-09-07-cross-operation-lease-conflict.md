# Plan — Closing Increment A's cross-operation lease gap

Spec: `docs/superpowers/specs/2026-09-07-cross-operation-lease-conflict.md`

Single task, no parallel waves — one function's conflict check widens, and every other change is a
mechanical consequence of that.

## Task

Owns: `packages/core/src/state/sqlite-store.ts` (`acquireRepositoryOperationLease` and its private
`#repositoryOperationLease` / row-lookup helper) · `packages/core/src/analysis/operation-lease.ts`
(only if the widened result shape needs a new field threaded through — read it first, it may need
no change at all) · every test file that exercises lease conflicts.

1. Read `packages/core/src/state/sqlite-store.ts`'s current `acquireRepositoryOperationLease` and
   its row-lookup helper in full before changing anything (the spec quotes the relevant lines, but
   line numbers drift).
2. Change the lookup to select every row for `repository_id` instead of the single
   `(repository_id, operation)` row.
3. Loop the existing conflict/expiry/liveness/adopt checks over each row found, per the spec's
   "Decision" section — same-operation rows behave exactly as today; other-operation rows now get
   the same treatment instead of being invisible.
4. Make sure `stage`/`subjectWorktreeId` inheritance only happens when the blocking row's
   `operation` equals `input.operation` (same-operation resumption) — never across operations.
5. Make sure `adopt === true` deletes every row that passed the liveness check, not just the one
   sharing `input.operation`, before the new row is inserted.
6. Re-run `bun run typecheck` to find every call site the result shape or lookup helper's signature
   change touches (the item-44 work used this same technique to enumerate every affected test).

## Tests to add or extend

- `packages/core/src/state/__tests__/sqlite-store.test.ts` / `sqlite-store.scenario.ts` — a new
  scenario: acquire a `gc` lease, then attempt to acquire a `remove` lease on the *same*
  `repository_id` while the `gc` lease is live → expect `outcome: 'conflict'` naming the `gc`
  holder. Mirror the existing same-operation conflict test's shape.
- Same file: an abandoned (`'gone'`) `gc` lease does not block a `remove` acquire with
  `adopt: true`, and the resulting `remove` lease's `stage`/`subjectWorktreeId` come from the
  `remove` request, not the dead `gc` row.
- `packages/core/src/analysis/__tests__/operation-lease.test.ts` / `.scenario.ts` — extend
  `FakeLeaseStore` (or whatever fake backs this suite) to hold more than one operation's row per
  repository, so the fake's own conflict logic isn't accidentally narrower than the real store's
  new behavior.
- `packages/core/src/analysis/__tests__/removal-lifecycle.test.ts` and
  `packages/core/src/resources/__tests__/gc-repository-lease.test.ts` — the two real call sites
  named in the spec's problem statement (`remove-worktree.ts`, `resources/gc.ts`). Add a test that
  a `remove` lease held by one process blocks a `gc --apply` on the same repository from the other
  side, i.e. the same claim `daemon-lease-conflict.scenario.ts` already proves for two `remove`
  calls, but across the two different operations this time.
- `docs/18-errors-json-contract.md` — check whether its `WTM_OPERATION_CONFLICT` example still
  matches (it should; the context shape is unchanged) and update only if the example's `operation`
  value needs to change to demonstrate the cross-operation case.

## Close-out

- `todo.md` item 2: flip the two `[~]` lines to `[x]` with a short closing note (which files
  changed, which test proves the CLI-remove-vs-daemon-gc case), and flip the item's own
  `### [ ] 2.` header to `### [x] 2.` once every sub-line is `[x]` or explicitly still open
  (`repair`, per the spec, stays unchecked on purpose — do not mark the whole item done if that
  line still reads open, follow the same convention item 9's Windows section already uses for a
  deliberately-partial close).
- Full local gate before committing: `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e` — same bar every other item in this backlog was held to.
