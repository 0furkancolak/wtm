# `wtm create` (todo item 6)

## Status

Open — planned, not started. `todo.md` item 6 states the gap in one line: *"WTM worktree
lifecycle'ın sonunu yönetiyor fakat başlangıcını doğrudan yönetmiyor."*

## Problem, with real evidence

There is no `git worktree add` anywhere in production code. The only occurrences in the
repository are in test fixtures (`packages/testkit/src/git-fixture.ts`,
`packages/testkit/src/workspace-fixture.ts`) and in one scenario that exists precisely to
characterize what happens *after* somebody else creates a worktree
(`packages/cli/src/__tests__/reconcile-fallback.scenario.ts`). WTM removes worktrees safely,
analyzes them, ranks them for cleanup, runs tasks in them — and cannot make one.

### Most of item 6's checklist is already built

Item 6 lists nine sub-items. Three of them describe machinery that exists and runs today; a
`create` command has to *trigger* it, not build it.

| Sub-item | Where it already lives |
| --- | --- |
| Worktree oluşturulduktan sonra reconcile | `reconcileContainingRepository` and `announceRegistration` (`packages/cli/src/main.ts`) |
| `worktree.created` event entegrasyonu | `LifecycleEventDispatcher.onReconciled` (`packages/daemon/src/events.ts`) dispatches `worktree.created` for every worktree a non-first reconcile discovers |
| Eager/lazy resource prepare policy ile uyum | `LifecycleEventDispatcher.prepareDiscovered` reads `[prepare] mode` and prepares only under `eager` |

So the daemon already owns everything downstream of the directory existing. What is missing is
the directory, and the refusals that should come before it.

### Two things the codebase has no answer for

**Where a worktree goes.** There is no configured worktree root, no path template, and no
convention. `wtm init` discovers repositories by walking up to five levels
(`docs/09-init-scope-discovery.md`), so it imposes no layout: the workspace fixture puts one
repository under `services/`, another under `tools/`, and a linked worktree at the workspace
root. The single closest thing to a convention in the repository is
`reconcile-fallback.scenario.ts`, which builds `<workspace>/repo` and `<workspace>/repo-feature`.

**"The same feature" across repositories.** `todo.md`'s multi-repo acceptance criterion —
*"Multi-repo create aynı feature identity altında çalışıyor"* — names a concept the data model
does not have. `[repos.<name>]` describes a repository (`packages/core/src/config/schema.ts`,
`config/repos.ts`), but nothing joins one repository's worktree to another's: `WorktreeRecord`
belongs to exactly one `repositoryId` and there is no grouping key anywhere in
`packages/core/src/state/store.ts`.

## Decision

### The target path is `<workspace>/<repository-directory>-<branch-slug>`

Chosen over a per-feature directory (`<workspace>/<branch>/<repo>`) and over a configurable
template, for this wave. It writes nothing inside the repository, `wtm init`'s existing
discovery finds it with no new configuration, and it is the layout the repository's own scenario
already builds. A `[worktrees] path` template can be added later without moving anything: the
default becomes the template's default.

The slug maps every character outside `[A-Za-z0-9._-]` to `-`, collapses runs, and trims leading
and trailing `-` and `.`. `feat/auth` becomes `feat-auth`.

Two different branches can slug to the same directory (`feat/auth` and `feat-auth`). That is not
resolved by disambiguating the name — a generated `-2` suffix would make the path unpredictable,
and the whole point of a computed path is that a person can guess it. The second `create` finds
the directory occupied and refuses, which is a sentence the user can act on.

### Every refusal happens before Git writes anything

`create` runs its checks first and creates second, so a rejected create leaves no directory, no
branch and no registry row:

- the branch name is one Git accepts (`git check-ref-format --branch`);
- the target path does not exist;
- the branch is not already checked out in another worktree of this repository, which Git would
  refuse anyway — but as a pre-flight it can name *which* worktree holds it;
- `--from` is not combined with a branch that already exists, because "create it starting here"
  and "check out the one that exists" are different requests and guessing between them is how a
  user ends up on a branch they did not mean.

### The start point is the main worktree's HEAD, not the caller's

`git worktree add -b` defaults to the HEAD of wherever it runs. `wtm create` runs against the
repository's main root, so its default is the main worktree's HEAD regardless of which worktree
the user is standing in. That is what makes the first acceptance criterion — *"Tek repo create
deterministic"* — true: the same command in the same repository produces the same branch point
from any directory. `--from <ref>` overrides it explicitly.

### `create` takes no repository operation lease

`repository_operation_leases` covers `remove | gc | repair` — the operations that destroy. Since
2026-09-07 a lease excludes the whole repository, not just its own operation, so adding `create`
to that set would make an additive command block on a garbage collection that cannot touch it.
Creating a worktree adds a directory and a registry row; it destroys nothing, and it stays out.

### With the daemon down, the hooks do not run, and `create` says so

If a daemon is answering, `create` announces the registration and the daemon reconciles,
dispatches `worktree.created` and applies `[prepare] mode` — the existing path, unchanged.

If no daemon is answering, `create` reconciles the repository itself, because handing back an
unregistered worktree would fail at the command's own job. But there is no event dispatcher in
the CLI: `LifecycleEventDispatcher` lives in `@wtm/daemon` and only the daemon runs it. So
`[events."worktree.created"]` tasks do **not** run, and neither does `eager` preparation. That is
reported as a `WTM_DAEMON_UNAVAILABLE` warning naming what was skipped, rather than left for the
user to discover when their `deps.install` hook never fired.

This is not a defect `create` introduces. The local reconcile already consumes the `discovered`
result that the daemon's dispatch reads from, so any read command run with the daemon down
already has this effect (`reconcileContainingRepository`). `create` is the first command where
it is worth saying out loud.

### Scope: one repository now, multi-repo deferred with its reasons

Item 6's own "Minimum CLI" section is single-repository (`create`, `--from`, `--json`); multi-repo
is a separate section. This wave ships the first. `--repos web,api,worker` is **out**, and so are
the two sub-items that exist only to serve it, because both need decisions this wave cannot make
honestly:

- *Multi-repo branch alignment* needs a cross-repository grouping the data model does not have.
  Nothing joins two repositories' worktrees, and inventing that key is a data-model change, not a
  command.
- *Partial multi-repo creation rollback/recovery* needs N repositories held while the creation
  runs. `remove` solves the equivalent problem with a lease whose row is its own journal and a
  `--resume` that adopts it; doing the same across N repositories raises a lock-ordering question
  (a deterministic acquisition order, or two multi-repo creates deadlock) that deserves its own
  spec rather than a paragraph in this one.

## Acceptance criteria (verbatim from `todo.md`)

- [ ] Tek repo create deterministic. — a computed path, a start point that does not depend on the
      caller's directory, and every refusal decided before Git writes.
- [ ] Multi-repo create aynı feature identity altında çalışıyor. — **out of scope this wave**; the
      identity it names does not exist in the data model.
- [ ] Yarım kalan creation güvenli biçimde recover ediliyor. — **out of scope this wave**; there is
      nothing partial to recover from a single-repository create, which is one `git worktree add`.

## Out of scope

- `--repos`, and any cross-repository grouping.
- A `[worktrees] path` configuration key. The default is chosen so one can be added over it later.
- Any change to `wtm remove`, the lease protocol, or the event dispatcher.
- Running the `worktree.created` hooks from the CLI. That would put a second event dispatcher in
  the tree, and two writers deciding when an event has been announced is the defect
  `claimLifecycleEvent` exists to prevent.

## Plan

See `docs/superpowers/plans/2026-09-07-create-worktree.md`.
