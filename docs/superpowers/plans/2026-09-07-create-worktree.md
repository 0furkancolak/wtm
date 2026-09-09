# Plan — `wtm create`

Spec: `docs/superpowers/specs/2026-09-07-create-worktree.md`

Four tasks in sequence. Task 1 is the pure core the rest depends on, Task 2 the Git write, Task 3
the CLI command and its registration handoff, Task 4 documentation and close-out. Do not start
Task 3 before Task 2 is green: the refusals are far cheaper to get right against a function than
against a spawned CLI.

## Task 1 — The path and the refusals, in core

Owns: `packages/core/src/analysis/create-worktree.ts` (new) and its tests. Exported from
`packages/core/src/index.ts`.

1. `worktreeDirectoryName(repositoryDirectory, branch)` — the slug rule from the spec. Every
   character outside `[A-Za-z0-9._-]` becomes `-`, runs collapse, leading and trailing `-` and
   `.` are trimmed. A branch that slugs to nothing is a refusal, not a fallback name.
2. `planWorktreeCreation(input)` — pure, takes the workspace root, the repository record, the
   branch, the existing `GitWorktreeRecord[]` topology, whether the branch exists, whether the
   target path exists, and the optional `--from`; returns either the plan (`path`, `branch`,
   `startPoint`, `createsBranch`) or a `WtmError`. It performs no I/O: the caller measures the
   world and hands it in, the same shape `acquireLease` uses for process liveness.
3. Refusal order is fixed and tested, because a user who typed two wrong things should be told
   about the first one every time.

### Tests to add

`packages/core/src/analysis/__tests__/create-worktree.test.ts`:

- `feat/auth` becomes `<repo>-feat-auth`; a branch of only separators is refused rather than
  producing a bare or empty directory name;
- a branch already checked out elsewhere is refused, and the error names the worktree that holds
  it;
- an occupied target path is refused, and the error carries the path;
- `--from` with an existing branch is refused; `--from` with a new branch sets `startPoint`;
- with no `--from`, `startPoint` is the main worktree's HEAD and not the caller's;
- two branches that slug alike produce the same path, so the second is refused by the occupied
  check rather than silently renamed;
- refusal precedence: an invocation that is wrong in two ways reports the first refusal in the
  documented order.

## Task 2 — The Git write

Owns: `packages/core/src/analysis/create-worktree.ts` (the effectful half).

1. `createWorktree(plan, repoPath)` runs `git worktree add` with `-b` only when the plan says the
   branch is new, and passes the start point explicitly rather than relying on Git's default.
2. Validate the branch name through `git check-ref-format --branch` before the add, and map a
   Git failure to `GIT_COMMAND_FAILED` through the existing error mapping — do not invent a
   second vocabulary for what Git already says clearly.
3. Return the created worktree's path, branch and HEAD by reading the topology back, not by
   assuming the write did what was asked.

### Tests to add

- a real fixture creates a worktree at the computed path, on a new branch, from the main
  worktree's HEAD while the test stands in a *different* worktree;
- `--from` starts the branch at the named ref;
- an existing branch is checked out rather than recreated;
- a Git refusal surfaces as `GIT_COMMAND_FAILED` carrying Git's own message.

## Task 3 — The CLI command

Owns: `packages/cli/src/commands/create.ts` (new), `packages/cli/src/main.ts` (registration),
`packages/protocol/src/errors.ts`, `packages/cli/src/exit-codes.ts`.

1. Register the two new codes — `GIT_BRANCH_IN_USE` and `WTM_WORKTREE_PATH_OCCUPIED` — and
   classify both in `exitCodeForError`. They are safety refusals in the same class as a Git
   blocker: nothing was done and the caller has somewhere to look, which is exit 3.
   `__tests__/exit-codes.test.ts` enumerates every registered code, so an unclassified one fails
   the suite.
2. `wtm create <branch> [--from <ref>] [--json]`. Resolve the workspace and repository through
   `findRegistration`; an unregistered directory is `WTM_NOT_INITIALIZED`, because the workspace
   root the path is computed from is something only the registry knows.
3. After the write, hand the registration off exactly as `init` does: announce to a reachable
   daemon and let it reconcile, dispatch `worktree.created` and apply `[prepare] mode`. With no
   daemon, reconcile locally and warn `WTM_DAEMON_UNAVAILABLE` naming what did not run — the
   hooks and `eager` preparation. Never do both.
4. The envelope reports the created worktree, whether the branch was created or checked out, the
   start point, and which of the two registration paths ran, so `--json` callers can tell whether
   hooks fired without inspecting the daemon.

### Tests to add

- `packages/cli/src/__tests__/create.scenario.ts` + `create.test.ts` — a spawned scenario, because
  the production CLI opens the real state store and `SQLiteStateStore` construction crashes Bun's
  test process (this is why every other production-CLI test in this package is a scenario child);
- the created worktree is registered and `wtm status` inside it answers about it;
- with the daemon down, the command still succeeds, the worktree is registered, and stderr names
  the skipped hooks without telling the user to run `wtm init`;
- each refusal exits 3 with its code and leaves no directory behind — assert the absence, since
  "nothing was created" is the load-bearing half of a refusal;
- `--json` stdout parses as exactly one envelope.

## Task 4 — Documentation and close-out

- `docs/04-cli-reference.md` — a `wtm create` section beside `wtm remove`: the computed path rule,
  the start-point default, `--from`, and the envelope's fields.
- `docs/18-errors-json-contract.md` — the two new codes, what each means and what it carries.
- `docs/10-git-safety-worktree-analysis.md` — a line pointing at `create` from the lifecycle it
  already describes the end of.
- `todo.md` item 6: **six `[x]` and three `[ ]`**. The three multi-repo lines stay open with the
  reasons written down, the first acceptance criterion closes and the other two stay open marked
  out-of-scope-this-wave, and the item header stays `[ ]` — item 2's `repair` line and item 7's
  reclaimable line already use this convention.
- Update Increment H in `docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`.
- Full local gate before committing: `bun run lint`, `bun run typecheck`, `bun run test`,
  `bun run test:e2e`.
