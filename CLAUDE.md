# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. It records the rules that
are load-bearing here and easy to break by accident. Human-facing setup, prerequisites and the
full pre-PR gate list live in [CONTRIBUTING.md](CONTRIBUTING.md); the architecture and contracts
live under [`docs/`](docs/README.md). This file does not repeat them — it says what an agent has
to hold in mind while changing code.

## Layout

Bun workspaces under `packages/`: `protocol` (wire format and shared types), `platform` (every
OS-specific fact), `core` (state, planning, analysis), `adapters` (task backends), `daemon`,
`cli`, `testkit`. Docs are numbered under `docs/`, decisions under `docs/adr/`, plans and specs
under `docs/superpowers/`, the agent skill at `skills/wtm/SKILL.md`, the outstanding work in
`todo.md`.

## Layering

The dependency direction is **protocol ← platform ← core ← daemon/cli**. `adapters` depends on
`protocol` only.

`@wtm/core` and `@wtm/protocol` must not know what operating system they are running on: no
`spawn`, no `execFile`, no `process.platform`, no import of `@wtm/platform`, and no OS-specific
paths or literals — **including in comments**. Core takes every platform fact as a port injected
by the composition root (`cli`/`daemon`).

This is not a review convention, it is a test:
`packages/core/src/__tests__/platform-independence.test.ts` scans both packages and fails on
re-entry. Widening it means adding an entry with a written reason to a literal array, which is
the intended friction — do that rather than reaching for a looser regex.

## TypeScript and lint rules

- `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on
  (`tsconfig.base.json`). An optional property that may be absent must be omitted, not set to
  `undefined`.
- Relative imports are **extensionless**.
- Every `*.test.ts` and `*.scenario.ts` lives under the owning source directory's `__tests__`
  directory.

The last two are enforced by `bun run lint` (`scripts/lint.ts`), which is a plain repo scanner —
there is no ESLint.

## Test rules

- **Child processes in tests start only through `runScenario`** (`@wtm/testkit`). Do not hand-roll
  a `spawn` in a test.
- **better-sqlite3 is never run in-process under Bun.** Store tests run under Node as
  `*.scenario.ts` files; the parent test asserts on the JSON the scenario prints.
- **Tests never run a real `gh` and never reach the network.**
- **Tests never touch real user state** — not the contributor's `~/Library` WTM state, Git config,
  LaunchAgents or systemd units. Use temporary repositories, local bare remotes, injectable
  state/socket paths and isolated homes.
- **Never use a bare `git stash`** — it can swallow a contributor's uncommitted work.
- Fixture tests establish parsing and state transitions; native tests establish real process,
  filesystem, transport and service behaviour. Report them separately, and never weaken a safety
  assertion to make a platform job green.

## The envelope contract

Operational JSON commands return exactly:

```
{ schemaVersion: 1, ok, command, data, warnings, errors[{ code, message, severity, context?, remediation? }] }
```

When `ok` is false, `errors` is non-empty and the CLI exits nonzero. A `remediation` entry is a
suggestion, never an action taken automatically. **Every new error code is written into
[`docs/18-errors-json-contract.md`](docs/18-errors-json-contract.md) in the same change.**

## Migrations

Adding a migration changes three files together, or the standalone executable ships without it:

1. a new numbered file in `packages/core/src/state/migrations/`,
2. `packages/core/src/state/assets.ts`,
3. `packages/cli/src/sea-assets.ts`.

## Gate before pushing

```bash
bun run typecheck && bun run lint && bun run test
```

Run resource-heavy gates **sequentially** — one gate at a time per machine, including when several
agents share the repository. `make check` is the same three; `make verify` is the whole release
gate. See CONTRIBUTING.md for the full pre-PR list (`test:e2e`, `test:perf`, `package:verify`,
`binary:verify`).

Commit messages use a conventional prefix (`fix(platform):`, `docs:`, `ci:`) and end with the
`Co-Authored-By:` trailer for the model that wrote them.

## CI and the merge condition

- **A change may merge when every non-`win32` job is green on the head commit.**
- The `win32` leg is **informational** (`continue-on-error`) until todo item 9 lands: roughly 80
  tests fail natively there today, so it reports without deciding the run, and stops at 25 minutes.
- **Windows work needs its own evidence.** Dispatch CI with the `win32_test_filter` input
  (`workflow_dispatch`) to run a named group of test files on the win32 leg alone; a filter run is
  not informational, so its result decides. The other four legs skip their steps on such a run.
- Before merging, merge `origin/main` into the branch and resolve conflicts there.

## Working in this environment

These are quirks of the cloud sandbox, recorded 2026-09-18 from
[`docs/superpowers/plans/2026-09-16-w1-cloud-handoff.md`](docs/superpowers/plans/2026-09-16-w1-cloud-handoff.md).
Verify before relying on one; they describe the sandbox, not the repository.

- **`gh` is not installed.** Read and write GitHub through the MCP tools or the REST API. (Tests
  must not call `gh` at all — that is a repository rule, above.)
- **Raw Actions log downloads are proxy-blocked** (`blob.core.windows.net` → 403 CONNECT). Read
  job logs through the API instead.
- **Re-running a failed job is refused** (403 on `rerun-failed-jobs`). To get a fresh run, refresh
  the branch onto `main` — a real commit, not an empty one.
- **Remote branch deletion is refused** (403 on `DELETE git/refs`, and `git push --delete` is
  rejected too). Merged unit branches therefore stay on the remote and are pruned by hand later.
- **The sandbox runs as root.** Four test files fail on *any* branch, including the merge base:
  `cli/__tests__/reconcile-fallback`, `daemon/__tests__/main`, `daemon/__tests__/process-anchor`,
  `daemon/__tests__/server.integration`. Several of their tests refuse uid 0 outright. Compare a
  gate result against the merge base before calling a failure a regression.
- **The host is Linux**; macOS and Windows evidence comes from CI only.
- **Check the toolchain.** The repo pins Bun 1.3.14 and the daemon requires Node >= 24; the
  sandbox's `bun` and `node` are often older. Put a Node 24 runtime on `PATH` before running
  daemon scenario tests.
