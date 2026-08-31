# Destructive Operation Safety — Implementation Plan

Design: `docs/superpowers/specs/2026-08-31-destructive-operation-safety-design.md`
Scope: `todo.md` items 1, 2, 3.

## Rules for every task

- Write the failing test first, run it, and confirm it fails for the stated reason before implementing.
- Relative imports are extensionless. Every `*.test.ts` / `*.scenario.ts` lives under a `__tests__`
  directory. `bun:test` with `test`, not `it`.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on: conditional spreads for
  optional properties, explicit `| undefined` on optional interface members, `?? fallback` on
  indexed reads.
- Finish a task with `bun run lint`, `bun run typecheck`, and the task's own tests green.
- Do not touch files another task owns.

## File ownership

| Task | Owns |
|---|---|
| 1 | `packages/protocol/src/errors.ts`, `packages/protocol/src/__tests__/`, `docs/18-errors-json-contract.md`, `packages/core/src/analysis/remove-policy.ts` |
| 2 | `packages/core/src/runtime/process-identity.ts` + its `__tests__` |
| 3 | `packages/core/src/state/**`, `packages/core/src/index.ts` |
| 4 | `packages/core/src/analysis/operation-lease.ts` + its `__tests__` |
| 5 | `packages/core/src/analysis/remove-worktree.ts` + its `__tests__` |
| 6 | `packages/cli/src/**` |
| 7 | `packages/core/src/analysis/{worktree-analysis,remote-persistence}.ts`, then the CLI flag |
| 8 | `docs/`, `skills/`, `README.md`, `CHANGELOG.md` |

Tasks 1, 2 and 3 are disjoint and run in parallel. 4 needs 2 and 3. 5 needs 4. 6 needs 5. 7 needs 5
to have landed (shared analysis surface). 8 is last.

---

## Task 1 — `WTM_OPERATION_CONFLICT` and a doc/enum parity test

1. Failing test in `packages/protocol/src/__tests__/errors.test.ts`: `wtmErrorSchema` accepts
   `code: 'WTM_OPERATION_CONFLICT'`.
2. Failing test: the code list in `docs/18-errors-json-contract.md` and `wtmErrorCodeSchema` contain
   exactly the same set. Parse the fenced `text` blocks under "Stable V1 error families"; compare as
   sets; report the symmetric difference in the failure message.
3. Add the code to the scope/config family in the enum and in the document, together with the three
   daemon codes the document currently omits.
4. `WorktreeRemovalBlockedError.code` is not a protocol code. Rename the field to
   `reason: 'worktree-removal-blocked'` and update `packages/core/src/analysis/__tests__/remove-policy.test.ts`.

## Task 2 — Process start identity in core

1. Failing test: `readProcessStartIdentity(process.pid)` returns a non-empty `processStartTime`, and
   a PID that cannot exist returns `null`.
2. Failing test: `installProcessStartIdentityReader` replaces the reader, and the installed reader
   receives the PID it was asked about.
3. Implement with `ps -ww -p <pid> -o lstart=`, `LC_ALL=C LANG=C`, 1 s timeout, 64 KiB buffer;
   exit code 1 with empty stdout and stderr means absent; more than one output line is a failure,
   not a guess.
4. Do not export from `packages/core/src/index.ts` yet — Task 4 owns that edit.

## Task 3 — `repository_operation_leases` and explicit endpoint release

1. Failing test in the `sqlite-store` scenario: acquire, conflict on a second acquire, release with
   the right token, and a wrong token releasing nothing.
2. Failing test: a lease past `expires_at` whose owner the liveness callback reports `alive` is
   still a conflict; the same lease with `gone` is reported `abandoned`, and only `adopt: true`
   takes it over.
3. Failing test: a lease whose stored `process_start_time` differs from the live process's is
   `abandoned` even at the same PID.
4. Failing test: `advanceRepositoryOperationLease` records a stage only for the holding token;
   `renewRepositoryOperationLease` extends `expires_at` and refuses an expired lease.
5. Failing test: `releaseEndpointLeasesForWorktree` flips only that worktree's `ACTIVE` leases,
   returns the count, and the port becomes allocatable again.
6. Failing test: `forgetRepository` deletes the repository's operation leases.
7. Migration `010-repository-operation-leases.sql`; append to `assets.ts`; update `assets.test.ts`
   and both `migrationVersions` assertions.
8. Implement the four lease methods plus the endpoint release in `sqlite-store.ts`, contracts in
   `store.ts`, type exports in `state/index.ts` and `packages/core/src/index.ts`.
9. Extend `database-contract.scenario.ts` so both drivers prove identical behaviour, and
   `packages/testkit/src/managed-process-store.ts` if the daemon fake needs the new members.

## Task 4 — Lease orchestration in core

1. Failing test: `withRepositoryOperationLease` runs the body, releases on success, and releases on
   throw.
2. Failing test: a conflicting lease makes it throw `RepositoryOperationConflictError` with
   `code: 'WTM_OPERATION_CONFLICT'` and context naming the holder PID and acquisition time.
3. Failing test: an abandoned lease throws with `abandoned: true`, the recorded stage, and a
   `--resume` remediation; with `adopt: true` it runs the body instead and reports the stage it
   resumed from.
4. Failing test: the body can record stages, and a body that throws leaves the stage in the row.
5. Implement over the Task 3 store methods and the Task 2 identity reader; TTL 120 s, renewed at
   every stage transition.
6. Export from `packages/core/src/index.ts`.

## Task 5 — Runtime-aware removal lifecycle

1. Failing test: with a coordinator recording calls, the stages run in the documented order and
   `git worktree remove` runs last.
2. Failing test: a coordinator whose `stopManagedProcesses` throws leaves the worktree on disk and
   in the topology.
3. Failing test: residue reported by `verifyManagedProcessesStopped` blocks the removal and no
   later stage runs.
4. Failing test: a file written into the worktree during cleanup is caught by the second analysis
   and blocks removal.
5. Failing test: the existing TOCTOU commit case still blocks, now with cleanup in between.
6. Failing test: resuming from `release-endpoints` skips nothing unsafely and completes.
7. Implement: coordinator port, stage recording through the lease, no-coordinator default that
   refuses when runtime work exists.
8. Keep the in-process mutex, acquiring the DB lease inside it.

## Task 6 — CLI production wiring

1. Failing test: `remove` on a worktree with an active managed process record and no daemon fails
   with `WTM_DAEMON_UNAVAILABLE`, exit code 4, and the worktree survives.
2. Failing test: the success envelope carries the `cleanup` block, and endpoint leases for the
   worktree are `RELEASED` afterwards.
3. Failing test: a blocked removal now reports the analysis warnings it used to drop.
4. Failing test: `WTM_OPERATION_CONFLICT` maps to exit code 3.
5. Failing scenario: two `wtm remove` child processes on one repository — exactly one succeeds, the
   other reports `WTM_OPERATION_CONFLICT`.
6. Failing scenario: a child killed mid-cleanup leaves an adoptable lease; a plain re-run refuses
   and names the stage; `--resume` completes it.
7. Implement the production coordinator over `DaemonClient` + `SQLiteStateStore`, add `remove` to
   the daemon-client command list, open the store read-write for `remove`, add `--resume`.

## Task 7 — Remote freshness

1. Failing test: default analysis emits `remoteKnowledge.source === 'local-refs'` and
   `confidence === 'LOCAL_ONLY'`.
2. Failing test: with a branch deleted on the bare remote, analysis without the flag still reports
   HEAD as remote-persisted, and `--refresh-remotes` reports it as not persisted.
3. Failing test: `refreshedAt` is set only after a refresh.
4. Failing scenario: default analysis runs no `git fetch` — a `git` shim on `PATH` that fails on
   `fetch` does not affect it, and does fail the refreshing variant.
5. Implement `refreshRemoteTrackingRefs`: derive remote names from the allowed patterns, run
   `git fetch --prune` per remote, fail closed with `GIT_COMMAND_FAILED`.
6. Wire `--refresh-remotes` into `analyze` and `remove`.

## Task 8 — Documentation parity

1. `docs/04-cli-reference.md`: `--refresh-remotes`, `--resume`, the cleanup block, the new exit-code
   mapping.
2. `docs/10-git-safety-worktree-analysis.md`: the implemented lifecycle replaces the promised one;
   the remote-freshness section stops describing `--refresh-remotes` as future.
3. `docs/13-data-model-and-state-machines.md`: the new table.
4. `skills/wtm/SKILL.md`: removal now stops processes; agents must not `kill` around WTM.
5. `CHANGELOG.md`.
6. Tick the completed boxes in `todo.md` items 1, 2, 3 and the Removal/Remote-safety checklists.
