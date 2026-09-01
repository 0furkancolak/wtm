# Increment B — task plan

Spec: `docs/superpowers/specs/2026-09-01-next-tag-packaging-design.md`
Program map: `docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`

Every task is test-first: a failing test that names the real behaviour, then the implementation.
A test that cannot be made red is allowed only when the agent says so explicitly and labels it a
characterization test. `bun run lint`, `bun run typecheck`, and the affected suites pass before a
task is complete.

New out-of-process scenarios must read their timeout from one shared constant, not add another
hard-coded literal. Every existing scenario carries its own, which is why the suite fails
nondeterministically on a loaded or slow host; this increment is not fixing that, but it must not
enlarge it.

## Ordering

File ownership, not conceptual grouping, sets the waves — two tasks never own one file.

| Wave | Tasks | Why together |
| --- | --- | --- |
| 1 | B1, B2, B3 | disjoint files, no dependencies |
| 2 | B4, B5 | B4 needs B1's derived code set; B5 needs B3 out of `commands/daemon.ts` |
| 3 | B6 | sole owner of `diagnostics.ts` + `state-diagnostics.ts`; needs B4's module |
| 4 | B7, B8 | B7 needs B6's `registration` finding; B8 needs B2's final message |

---

## B1 — Derive the CLI's known-code set from the schema

**Owns:** `packages/cli/src/commands/git-error.ts`, its tests.

`knownCodes` (`git-error.ts:75-111`) hand-lists all 36 codes and nothing holds it to
`wtmErrorCodeSchema`. A missing code is silently remapped to `GIT_REPOSITORY_DEGRADED`
(`git-error.ts:40-45`) and loses its exit code. Increment A fixed the drifted codes, not the
mechanism; this increment adds codes, so the mechanism has to go first.

- Red test: a code present in `wtmErrorCodeSchema` but absent from `knownCodes` is passed through
  rather than remapped. Assert against the schema's own options so the test cannot drift either.
- Derive the set from `wtmErrorCodeSchema`. Delete the literal list.
- Confirm no behaviour change for the 36 current codes.

**Done when:** adding a code to the schema requires no edit here, proven by a test that enumerates
the schema.

---

## B2 — `Unknown task` lists the tasks that exist

**Owns:** `packages/core/src/runtime/task-resolver.ts`, its tests.

`resolveTask` (`:37-42`) holds the validated config — and therefore `config.tasks` — when it decides
the task is unknown, and discards it. No CLI command lists tasks, so this message is the only place
the information can reach the user.

- Red test: unknown task against a config with several tasks — message names the known tasks.
- Red test: unknown task against a config with **no** tasks — message says how to define one, and
  does not print an empty list.
- Keep `code: 'WTM_CONFIG_INVALID'`. Put the names in `context` too, so `--json` consumers get a
  list rather than parsing prose.
- Bound the rendering: a workspace with 200 adapter-derived tasks must not emit an unreadable wall.
  Decide a cap, state it, and test the boundary.
- Names come from the same resolution order the resolver itself uses, so the list cannot advertise a
  task that then fails to resolve.

**Done when:** both messages are actionable and the JSON carries the list.

---

## B3 — No stack traces and no build-machine paths in user-facing output

**Owns:** `packages/cli/src/commands/daemon.ts`, `packages/cli/src/bin.ts`, their tests.

`daemon.ts:159` reads `error.stack ?? error.message` and writes it to stderr — the only `.stack`
read in non-test source. The envelope beside it is already clean (`:185-207`); this is a second,
parallel write. `bin.ts:9` has no catch-all, so anything escaping `runCli` becomes an unhandled
rejection with a full trace. `sea-bin.ts:28-34` already does the right thing — copy it.

- Red test: a daemon start failure produces no `/Users/runner`, no `.cjs`, and no `at ` frame marker
  in stdout or stderr.
- Red test: an unexpected throw escaping `runCli` exits non-zero with a one-line message, no trace.
- Keep the diagnostic value: the daemon's own log file is the right home for a stack. If the stack
  is retained anywhere, it goes to the log, never to the user's terminal.
- Do not change `scripts/build-sea.ts`. Frames naming the build host are normal; printing them is
  the defect.

**Done when:** every failing path tested emits one actionable line.

---

## B4 — One socket-path definition, and a preflight that measures the bound path

**Owns:** a new socket-path module (core), `packages/daemon/src/runtime-factory.ts`,
`packages/daemon/src/server.ts`, `packages/protocol/src/errors.ts`,
`docs/18-errors-json-contract.md`, `defaultDaemonSocketPath` in `packages/cli/src/main.ts`.
**Depends on B1.**

The path is defined three times and shared nowhere (`main.ts:1187`, `runtime-factory.ts:61`, `:73`).
The bound path is not the advertised one: `server.ts:184` binds `privateSocketPath(...)`
(`:765-771`) and links the published name afterwards (`:202`), so it is one byte longer. A check
measured against `wtmd.sock` passes at exactly the `HOME` length where the bind fails.

- Red test: a `HOME` whose bound path exceeds the limit is refused before `listen`, with the
  measured length and the limit in the error. Include a `HOME` in the one-byte band where the
  published path fits and the bound path does not — that band is the whole point of the task.
- Red test: a non-ASCII `HOME` is measured in bytes, not code units.
- One module owns the published path, the bind-path derivation, the platform limit and the
  preflight. All three current definitions consume it.
- Add `WTM_SOCKET_PATH_TOO_LONG` to `wtmErrorCodeSchema`, to `docs/18-errors-json-contract.md` (the
  parity test at `packages/protocol/src/__tests__/errors.test.ts:65-74` enforces this), and to
  `exitCodeForError` as exit 2. Attach a `command-suggestion` remediation.
- **Answer, do not assume:** is the quarantine sibling path (`server.ts:761-763`, 24 bytes longer)
  ever passed to `bind()`, or only to `rename()`? `sun_path` constrains addresses, not renames.
  Measure it and record the answer in the report.
- The CLI's connect side gets the same check, so `wtm ps` under a long `HOME` explains itself
  instead of reporting an unreachable daemon.

**Done when:** both processes refuse early with one line, and the limit lives in exactly one place.

---

## B5 — Per-`HOME` launchd label, migration, and a self-consistent `daemon status`

**Owns:** `packages/daemon/src/launchd.ts`, `packages/daemon/src/index.ts`,
`docs/04-cli-reference.md`, `docs/05-daemon-and-macos-runtime.md`, launchd tests.
**Depends on B3** (which releases `commands/daemon.ts`).

Riskiest task in the increment: it edits the file owning crash recovery for a transactional
on-disk publish protocol. Read §40 and D5 of the spec before starting — the design decision is made
and is not open.

- Label becomes `dev.wtm.daemon.<digest>`, digest derived from the resolved absolute `HOME`. Stable
  across runs, launchd-safe, collision-free across `HOME`s in one `gui/<uid>` domain.
- `LaunchdLifecycleResult.label` is typed `typeof launchdLabel` (`:121`). Widen to `string`; expect
  ripples through `index.ts:96` and consumers.
- Red test: two `HOME`s, one uid — neither reports the other's `state`/`runState`, and each
  `plistPath` belongs to the agent whose `state` is reported.
- Red test: an agent bootstrapped under the bare legacy label with **this** `HOME`'s plist is booted
  out and republished under the derived label; no orphaned service, no orphaned plist.
- Red test: a legacy service whose plist is **another** `HOME`'s is left untouched. Turning a
  reporting bug into a destructive one is the failure mode to design against.
- **Sweep the label-derived siblings.** `validateJournal` (`:1834-1840`) rebuilds
  `.tmp-`/`.replaced-`/`.removed-` names from the label, and the operation lock and journal paths are
  label-derived (`:508-509`). The label change is what strands them, so this task owns removing
  them. Test a stranded old-label journal.
- `docs/04-cli-reference.md` gains the `daemon status` output-field table it never had; the status
  payload names its label.
- Follow the file's existing house style for a thing it did not write (`:564-567` refuses rather
  than adopting) — and where this task departs from it, say so in the report.

**Done when:** two `HOME`s coexist, migration is proven, and no launchctl output parsing depends on
the 4 KiB-truncated `print` report.

---

## B6 — Diagnostics: preserve coded errors, and add the two new checks

**Owns:** `packages/cli/src/diagnostics.ts`, `packages/cli/src/state-diagnostics.ts`, their tests.
**Depends on B4** (socket-path module).

Sole owner of both files, so the three changes land together.

- **Preserve identity.** `toDiagnosticError` (`:437-466`) recognises only errors registered in the
  `diagnosticSourceItems` WeakMap (`:112`), so `DaemonRegistrationError` — which already carries
  `WTM_WORKSPACE_NOT_FOUND` and the message naming `wtm init` — is relabelled
  `GIT_REPOSITORY_DEGRADED` / "Diagnostic data source failed." Red test: `wtm env` in an
  unregistered worktree reports `WTM_WORKSPACE_NOT_FOUND`, its own message, exit 2. Scope strictly
  to errors already carrying a valid `WtmErrorCode`; anything else keeps the current fallback.
- **`socket-path` check** — the first host-scoped check. Reports headroom before it is a failure,
  using B4's module. Needs the enum (`:65`), `doctorOrder` (`:152-154`) and
  `unknownDoctorFindings` (`:155-162`) edited in lockstep.
- **`registration` check** — distinguishes "daemon unreachable" from "worktree not registered".
  This is the first check that probes the daemon; the spec accepts that deliberately (D2). Remove
  the misfiling at `state-diagnostics.ts:196-201`, where the "not inside a worktree" message
  currently surfaces as an **adapters** finding of status `unknown`.
- Red test: daemon down + registered worktree, and daemon up + unregistered worktree, produce
  different findings. One state must never be reported as the other.

**Done when:** `env` keeps its identity and `doctor` tells the two states apart.

---

## B7 — Reconciliation for a worktree created while the daemon was down

**Owns:** the reconcile fallback in `packages/cli/src/main.ts`, its tests. **Depends on B6.**

Two precedents to adopt rather than reinvent: `removal-coordinator.ts:208-240` already falls back to
an in-process local reconcile and warns `WTM_DAEMON_UNAVAILABLE`; `main.ts:975-981` already degrades
`resolve`/`run` on a `DaemonRegistrationError`.

- **First, prove or disprove the free half.** The daemon reconciles every registered repository at
  startup (`daemon/src/main.ts:198`), which may already satisfy "no manual `init` once the daemon
  returns". Write that test before writing any code. If green on an unchanged tree, label it a
  characterization test and say so — do not write code for a criterion already met.
- Red test: daemon unreachable, worktree created with `git worktree add`, a read command reconciles
  locally and sees it, warning that this happened.
- The fallback reconciles the *containing repository*, not the workspace — `init`'s full walk
  (`core/src/workspace/init.ts:56`) is too expensive for a read path. `removal-coordinator.ts:222`
  shows the cheap shape.
- A read command must never fail because the fallback failed. Warn and answer.
- Do not merge the two cwd→worktree lookups (out of scope) — but they must agree on whether the
  worktree is registered.

**Done when:** the user is never told to run `wtm init` for a worktree WTM could have found itself.

---

## B8 — Gatekeeper documentation and a quick start that runs

**Owns:** `README.md`, `CHANGELOG.md`, `todo.md`, docs parity tests. **Depends on B2.**

- **Gatekeeper (item 36).** Write the passage once, delimited by HTML comment markers, in
  `README.md`'s install section and in `CHANGELOG.md` — which `release.yml:184` publishes as the
  release body, so this is one source, not two documents. State the cause, give
  `xattr -d com.apple.quarantine wtm`, and say the `curl` path is unaffected because `curl`/`tar`
  write no quarantine attribute. Record in the docs that no in-process error is possible: the kill
  happens at `exec`, before any WTM code runs.
- Test: every required document carries both markers and the exact command. A half-removal in
  Increment G must fail loudly rather than leave stale advice to strip a security attribute.
- Add a line to `todo.md` item 5 pointing at the markers, so the person doing notarization finds the
  removal step where they will be looking.
- **Quick start (item 37).** Renaming `dev` to `make:dev` does **not** fix it — `make:` tasks exist
  only when the workspace has a `Makefile` with that target (`adapters/src/make.ts:54`). Move the
  task-definition step into the quick start so the sequence works on a clean workspace with no
  Makefile and no adapters.
- Test: a scenario executes the quick start against a temporary workspace and asserts each command
  exits 0. It must **derive the commands from `README.md`**, not hold a transcription — a test with
  its own copy proves the copy works and lets the README rot, which is precisely item 37.
- Tick the `todo.md` boxes this increment actually closes, and only those.
- While in `README.md`: it has two `## Configuration` headings (`:449`, `:451`).

**Done when:** a clean-workspace reader hits no wall, and the workaround cannot be half-deleted.
