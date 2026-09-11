# Closing Increment A's cross-operation gap

## Status

Implemented — 2026-09-07. Landed as designed, with one correction the design had wrong and one
addition it did not anticipate:

- **The policy layer needed widening too.** `operation-lease.ts` measured liveness from
  `readRepositoryOperationLease(key)` — this operation's row only — and its `ownerLiveness`
  callback deliberately answers `alive` for any row it did not measure. Widening the store alone
  would therefore have made a *crashed* `gc` refuse every `remove` on that repository forever,
  since nothing would ever have been allowed to notice the process was gone. The store gained
  `listRepositoryOperationLeases(repositoryId)` (a holder view, no tokens) and the policy layer
  now measures every lapsed row.
- **"the CLI error message already reports `holder.operation`" was not true.** `conflictFrom`
  built its message and context from `key.operation` — what the caller *asked* for. Identical to
  the holder's operation until this change, and misleading the moment they differ: a `remove`
  blocked by a `gc` would have said another process was performing "remove". The message now
  names the holder's operation and the context carries an additive `holderOperation`
  (`docs/18-errors-json-contract.md`).
- **The `abandoned` verdict has to wait for every row.** A live holder outranks a dead one, so a
  conflict still returns on sight but `abandoned` is only decided once the whole repository has
  been classified; reporting the first reclaimable row immediately would let an abandoned
  `remove` mask a running `gc` and send the user to `--resume` into a live destruction.

The rest of this document is the design as written before implementation, unchanged.

`docs/superpowers/specs/2026-08-31-destructive-operation-safety-design.md`
("Increment A") already shipped the repository-operation-lease mechanism and its own schema
comment says the missing piece explicitly: *"the operations that must exclude each other declare
that in code, not in the schema. V1 declares all three mutually exclusive per repository"* — but
the code was never written. `todo.md` item 2 carries the resulting two `[~]` (partial) lines as its
only remaining open work; every other line in item 2 is `[x]`.

## Problem, with real evidence

`repository_operation_leases`' primary key is `(repository_id, operation)`
(`docs/superpowers/specs/2026-08-31-destructive-operation-safety-design.md:141`). Every read/write
path keys off that same pair — confirmed by reading `packages/core/src/state/sqlite-store.ts`:

- `acquireRepositoryOperationLease` (line 1271) calls `this.#repositoryOperationLease(input)`,
  whose query is `WHERE repository_id = ? AND operation = ?` (line 1492-1493) — it only ever looks
  at the one row for *this* operation.
- The conflict, expiry, liveness and adopt checks (lines 1288-1308) all run against that single row.
- `renewRepositoryOperationLease` and the stage-write path key the same way.

Consequence, stated in `todo.md` (item 2, kabul kriterleri):

> CLI ve daemon aynı repository üzerinde çakışan destructive işlem yapamıyor. — kısmen: lease
> anahtarı `{repository_id, operation}`... farklı operasyonlar (CLI `remove` + daemon `gc` gibi)
> birbirini engellemiyor — bu hâlâ açık.

A `wtm remove` and a `wtm gc --apply` (or the daemon's own `gc`) on the same repository today
acquire two independent rows and both proceed. One can delete the worktree gc is walking, or gc can
reclaim a resource remove is mid-way through releasing. That is a real destructive-operation race,
not a cosmetic gap.

## Decision

Widen the **conflict check** to look at every lease row for `repository_id`, regardless of
operation. Do **not** change the schema or the primary key — Increment A's own design comment
already ruled that out on purpose (a later fourth operation must not require a table rebuild), and
`repair` is already in the `CHECK` constraint with no command behind it yet, which the schema is
built to tolerate.

Concretely, in `acquireRepositoryOperationLease`:

1. Replace the single-row lookup with `SELECT * FROM repository_operation_leases WHERE repository_id = ?`
   (all rows for this repository — today that is at most 3, one per operation in the `CHECK`).
2. For each row found, run the existing three checks unchanged (not-expired → conflict; liveness
   via `input.ownerLiveness` → conflict unless `'gone'`; not adopted → `'abandoned'`) — this is
   exactly today's per-row logic, just no longer skipped for a row whose `operation` differs from
   `input.operation`.
3. **Do not carry `stage`/`subjectWorktreeId` across operations.** Those two columns are one
   operation's journal (Increment A's design doc, "the row *is* the journal"). Today's code inherits
   `existing?.stage` into an adopted lease because adoption always resumes the *same* operation. A
   cross-operation row being cleared is not a resumption of anything — it is stale exclusivity from
   a finished or abandoned different operation — so the new row starts with `input`'s own
   `stage`/`subjectWorktreeId` (`null`/`undefined` unless the caller supplied them), never the dead
   row's.
4. On `adopt === true`, delete every row that passed the `'gone'` check (not just the one matching
   `input.operation`) before inserting — otherwise a second `acquire` call in the same run would
   immediately conflict with a sibling row nobody adopted.
5. The conflict/abandoned result's `holder` should be the *first* blocking row found, whichever
   operation it names — the CLI error message already reports `holder.operation`
   (`packages/protocol` / `docs/18-errors-json-contract.md`'s `{ repositoryId, operation, ... }`
   context), so a user asking to `remove` while a `gc` holds the repo sees which operation is
   blocking them, unchanged from today's per-op error shape.

This is a pure widening of an existing check, not new machinery: no new migration, no new lease
fields, no new `WTM_OPERATION_CONFLICT` variant.

## Acceptance criteria (verbatim from `todo.md` item 2)

- [x] İki terminal aynı repository üzerinde destructive işlem başlatamıyor. (already true, same-op)
- [x] CLI ve daemon aynı repository üzerinde çakışan destructive işlem yapamıyor — closed, and the
      CLI-`remove`-vs-daemon-`gc` case named explicitly in the note is what proves it
      (`daemon-lease-conflict.scenario.ts`, two real OS processes).
- [x] Crash olmuş process'in lease'i sonsuza kadar kalmıyor. (unaffected — still per-row liveness)

`repair` stays out of scope: there is still no `repair` command, so there is nothing to test it
against. The widened check is already correct for it the day it ships, by construction — that line
in `todo.md` stays as-is, not marked done by this change.

## Out of scope

- Any change to lease TTLs, liveness semantics, or the tri-state `alive`/`unknown`/`gone` verdict
  (`docs/superpowers/specs/` item 44 work) — this spec only widens *which rows* get checked, not
  *how* a row is judged live.
- A `repair` command itself.
- Any UX/CLI copy change beyond naming the blocking operation. (This turned out to be a change
  after all — see the Status note: there was no `holder.operation` in the rendered error.)

## Plan

See `docs/superpowers/plans/2026-09-07-cross-operation-lease-conflict.md`.
