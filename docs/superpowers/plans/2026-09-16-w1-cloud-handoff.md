# W1 cloud handoff — 2026-09-16

This note hands W1 of `docs/superpowers/plans/2026-09-15-remaining-work-waves.md` over to a cloud session. The local session was stopped because it was using too much RAM. Everything below was pushed before the stop.

## State

| Unit | Branch | Head | State |
|---|---|---|---|
| W1-1 | `claude/w1-1-ci-hang-f1` | wip | Only the start exists: `scripts/run-tests.ts` (a per-file test runner) and its test. Not reviewed. |
| W1-2 | `claude/w1-2-f2-runtime-factory` | wip | Uncommitted edits saved: `platform/src/process/darwin.ts` (start-time handling), plus tests. Not reviewed, not verified. |
| W1-3 | `claude/w1-3-tsx-daemon-jobs` | wip | Implementer was stopped mid-way: `platform/src/runtime-invocation.ts`, `source-runtime-hooks.ts`, `cli/src/main.ts`, `process-supervisor.ts` edits plus scenario tests. Its last note: "Need `client.start()` after the socket appears." Not verified. |
| W1-4 | `claude/w1-4-win32-test-filter` | `476d71a` + wip | Done and self-tested (12/0). Controller found a **Critical** bug: a job-level `if:` used `matrix`, which GitHub does not allow there. Fix round 1 (job `env` + step-level `if`, plus a regression test) was in progress; the wip commit holds it unverified. Next: verify, run the release-workflow test, then review. |
| controller | `claude/w1-controller-todo` | `f765f88` | PR #15 (todo-only). CI was green on linux x64/arm64 and darwin arm64; darwin x64 was still pending at handoff. Merge once it is green. |

W2 preparation (win32 failure clustering from runs `34873813789` / `34947190062` into 9a–9i) was started and did not finish. Redo it.

## Decisions already made by the user
- **W1 merge approval is given:** merge each W1 PR once every non-win32 CI job is green, after review and the gate.
- **K1:** `repair` is out of v0.2.0 scope. Item 2 is closed (done in PR #15).

## Extra evidence (9l Intel, belongs to W1-1)
Main run `34947190062` (`360a7da`), darwin x64, had two failures in `packages/daemon/src/__tests__/process-supervisor.test.ts`:
1. "RUNNING transition failure kills the group and terminalizes the created row": `:577` `readFile(descendantMarker)` returned ENOENT. The group was killed before the descendant wrote its marker, so the test has a race.
2. "restart holds ownership across stop and start against a competing supervisor": `restart` → `#stopLocked` threw `RUNTIME_STOP_FAILED` with reason `EPERM` (`process-supervisor.ts:606`; test `:672`). Decide whether EPERM on an already-exited group should count as gone.

Run `34947174999` (darwin arm64): F1 failed right after printing `error: Unsafe managed log target`.

## Ledger rulings
- W1-1 and W1-4 both touch `ci.yml`. W1-4 owns the `workflow_dispatch` input; W1-1 only touches the test step. Merge W1-4 first.
- In the cloud, run **one implementer at a time**, or at most two. Do not run the full `bun run test` gate in parallel with anything else.

---

# Global constraints (every W-unit)
- Repo: Bun 1.3.14 / TypeScript monorepo, Node 24.18.0. Layers: protocol <- platform <- core <- daemon/cli. Core never uses `spawn`, `execFile`, `process.platform` or `@wtm/platform`.
- `exactOptionalPropertyTypes` is on. Tests live under `__tests__`. Relative imports carry no extension.
- Child processes inside tests are started only via `runScenario` (testkit).
- better-sqlite3 is never loaded in-process under Bun: store tests are node `*.scenario.ts` files and the parent test asserts their printed JSON.
- Tests never run a real `gh` and never reach the network. Never touch the user's real `~/Library` WTM state. Never use bare `git stash`.
- Test names never contain `##[error]`.
- Envelope: `{schemaVersion:1, ok, command, data, warnings, errors[{code,message,severity,context?,remediation?}]}`. New error codes are documented in docs/18.
- A new migration changes three files together: `packages/core/src/state/migrations/NNN-*.sql`, `packages/core/src/state/assets.ts`, `packages/cli/src/sea-assets.ts`.
- Core's public API does not export `runGit`.
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- You (the implementer) never dispatch subagents, never push, never open PRs, never merge.
- Run the targeted tests you touch. Do NOT run the full `bun run test` suite (the controller runs the serialized gate); `bun run typecheck` and `bun run lint` are fine to run.
- Only tick todo.md lines that belong to your unit; never tick headings or the "Release checklist".
- Work only inside your worktree. Write your full report to the report path given; return only status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), commit SHAs, a one-line test summary and concerns.


---

# W1-1 — Intermittent macOS CI hang + flaky F1 + 9l Intel check
Worktree: `.worktrees/w1-1-ci-hang-f1` (branch `claude/w1-1-ci-hang-f1`, base origin/main 360a7da).

## Problem A (primary): macOS CI job silently hangs until the 30 min job timeout
- `.github/workflows/ci.yml` step `bun run test --timeout 60000` (package.json: `bun test --max-concurrency=1 --parallel=1 --timeout 30000`).
- Seen in runs: main `34897205539` (darwin x64), PR #11 `34940697455` (darwin arm64 and x64, two attempts). The same tree passes in 5–10 min on another run.
- On x64 both hung runs went silent at the same point: the 16th file after `scripts/__tests__/render-homebrew-formula.test.ts`. In one attempt `performance-report-entry` timed out at 60s and then the log went silent (probably a symptom).
- Bun CI output is buffered per file, so the hanging file is not identifiable from logs.
- You MAY read those logs read-only with `gh run view <id> --log` / `gh api` (reading GitHub is allowed for investigation; tests must never call gh).

Steps:
1. Make file order and per-file progress visible in CI so a future hang names its file (e.g. a small runner script under `scripts/` that runs `bun test` per file / prints start+end+duration per file, or a bun preload that logs; choose the least invasive option that keeps the same semantics: sequential, same timeouts, same file set, non-zero exit on any failure). Must not change what is tested. If you change the `test` script or ci.yml test step, keep a test covering it (see `scripts/__tests__/release-workflow.test.ts` which asserts ci.yml shape — update it accordingly). NOTE: unit W1-4 edits `.github/workflows/ci.yml` in parallel (adds a `workflow_dispatch` input `win32_test_filter` and uses it in the win32 test step). Keep your ci.yml edits minimal and confined to the test step; the controller resolves the merge.
2. Using the logs, the file ordering (reproduce Bun's file order locally) and code reading, identify the most likely hanging file(s): look for tests that can wait forever (unbounded awaits on child exit/socket/daemon, missing timeouts in afterAll/afterEach, processes left running that keep bun's event loop alive, hooks without timeouts — Bun's `--timeout` does not bound hooks in all cases). Fix the root cause (bounded waits, guaranteed teardown). If you cannot prove which file, add bounded teardown/timeouts to the candidates you identified and document the reasoning.
3. Add a job-level guard so a hang fails fast with a named file rather than the 30 min cap (e.g. per-file wall-clock limit in the runner script that prints the file name and kills it).

## Problem B: flaky F1
`packages/daemon/src/__tests__/process-supervisor.test.ts:1184` "daemon close leaves the anchor-owned writer rotating while recovery remains read-only" intermittently fails on CI (darwin arm64). Make it condition-based (wait for observable state with a bounded poll) instead of timing-based; fix any real race in production code if the failure reveals one. Use superpowers:systematic-debugging thinking: find the root cause, don't just bump sleeps.

## Problem C: 9l Intel (todo.md ~line 1596, "macOS regression yok" `[~]` line)
Intel x64 previously had 2 failures around rotation observation/recovery and stale process identity. Check whether current main's darwin x64 CI runs (e.g. `gh run list --workflow CI --branch main`) are green apart from the hang; if the stale-identity failure is not reproduced in recent green x64 runs, record the evidence (run id + commit) in that todo line and tick it `[x]`; otherwise leave `[~]` with updated evidence.

## Acceptance
- Hanging file identified (or candidate set with reasoning) and fixed; per-file visibility and fast-fail guard in CI; tests for any new script.
- F1 test condition-based; run it at least 20 times locally in a loop (`for i in $(seq 20); do bun test packages/daemon/src/__tests__/process-supervisor.test.ts -t 'daemon close leaves' || break; done`) with zero failures.
- `bun run typecheck && bun run lint` pass.
- Report: `.superpowers/sdd/2026-09-15-remaining-work-waves/W1-1-report.md` (absolute: .superpowers/sdd/2026-09-15-remaining-work-waves/W1-1-report.md).

---

# W1-2 — Flaky F2: runtime-factory `RUNTIME_PROCESS_IDENTITY_STALE`
Worktree: `.worktrees/w1-2-f2-runtime-factory` (branch `claude/w1-2-f2-runtime-factory`, base origin/main 360a7da).

`packages/daemon/src/__tests__/runtime-factory.test.ts:59` "default CLI client reaches the isolated production IPC address without runtime injection" intermittently fails on CI with `RUNTIME_PROCESS_IDENTITY_STALE`. You may read past CI logs read-only with `gh run list/view --log` to find the failing output (search runs on main and PRs from 2026-09-10 onward); tests must never call gh.

Steps (systematic debugging — root cause first):
1. Understand what the test spawns, how process identity (pid + start time) is recorded and compared, and when the STALE code is raised (grep `RUNTIME_PROCESS_IDENTITY_STALE` across packages).
2. Determine whether the flake is a test race (e.g. reading identity before the child has recorded it, start-time granularity/rounding between `ps` readings, clock resolution) or a real production bug (identity comparison too strict — e.g. start time read twice with different rounding). Fix at the root; if production code is wrong, fix it there with a unit test that reproduces the mismatch deterministically.
3. The test must be condition-based and bounded.

## Acceptance
- Root cause explained in the report with evidence.
- Deterministic regression test for the cause where possible.
- Loop the test 30 times locally with zero failures: `for i in $(seq 30); do bun test packages/daemon/src/__tests__/runtime-factory.test.ts || break; done`.
- Run the other tests of any production file you change.
- `bun run typecheck && bun run lint` pass.
- Do not touch `process-supervisor.ts`/`process-anchor.ts` unless unavoidable (unit W1-1 works on supervisor tests in parallel); if you must, say so in concerns.
- Report: .superpowers/sdd/2026-09-15-remaining-work-waves/W1-2-report.md

---

# W1-3 — todo 50c: tsx-launched daemon cannot start queued jobs
Worktree: `.worktrees/w1-3-tsx-daemon-jobs` (branch `claude/w1-3-tsx-daemon-jobs`, base origin/main 360a7da).

todo.md (item 50, ~line 959): "kaynaktan `node --import tsx` ile başlatılan daemon kuyruktaki işi başlatamıyor (`RUNTIME_START_FAILED`). Özel runner modları için yeniden çağrılan giriş noktası tsx yükleyicisini almıyor. Ölçüm build ile yapıldı. Testler bu durumu `developmentRuntimeInvocation()` ile aşıyor."

i.e. when the daemon runs from source via `node --import tsx packages/daemon/...`, it re-invokes its own entry point for special runner modes (job runner / process anchor etc.) without passing the parent's loader flags (`process.execArgv`, e.g. `--import tsx`), so the child fails to load `.ts` and the job fails with RUNTIME_START_FAILED. Tests work around it with `packages/testkit/src/runtime-invocation.ts` `developmentRuntimeInvocation()`.

Steps:
1. Find where the daemon (and CLI if relevant) builds the re-invocation command for runner modes (grep for `process.execPath`, `process.argv[1]`, runner mode flags, `execArgv`). Also see how the standalone SEA build re-invokes (must keep working; SEA has no execArgv loader).
2. Fix: when running under a non-SEA Node with loader flags, the re-invocation must carry the loader flags (inherit relevant `process.execArgv` entries such as `--import <x>`/`--loader`/`--experimental-*`, never `--inspect` ports that would collide — decide and document). Keep it in the platform/daemon layer per layering rules (core must not read process.* ).
3. Add a test that proves a daemon launched with `node --import tsx` can run a queued job end-to-end WITHOUT `developmentRuntimeInvocation()` injection (use `runScenario`; follow existing scenario patterns such as `packages/cli/src/__tests__/jobs-workflow.scenario.ts`). Keep existing tests that use the helper unless the helper becomes unnecessary — if so, you may simplify, but keep the change focused.
4. Update todo.md item 50: replace/annotate that paragraph to say it is fixed (with test name); tick only lines belonging to 50c if a matching checkbox exists (check the item's checkbox list).

## Acceptance
- Unit + scenario test for the loader-flag propagation; SEA path unchanged (existing `sea`/binary tests still pass when run targeted).
- Targeted tests for touched files pass; `bun run typecheck && bun run lint` pass.
- Report: .superpowers/sdd/2026-09-15-remaining-work-waves/W1-3-report.md

---

# W1-4 — ci.yml `workflow_dispatch` input `win32_test_filter`
Worktree: `.worktrees/w1-4-win32-test-filter` (branch `claude/w1-4-win32-test-filter`, base origin/main 360a7da).

Context: `.github/workflows/ci.yml` runs 5 legs; win32 is informational (`continue-on-error`, 25 min) because ~80 tests fail natively (todo item 9). Upcoming Windows units (W2–W5) need a way to prove a targeted group of test files green on the win32 runner within 25 minutes, without waiting for the whole suite.

Implement:
1. Add `workflow_dispatch.inputs.win32_test_filter` (string, default empty, description explaining it is a space-separated list of test file paths/patterns passed to `bun test`).
2. When the run is a `workflow_dispatch` with a non-empty `win32_test_filter`:
   - the win32 leg runs `bun test --max-concurrency=1 --parallel=1 --timeout 300000 <filter>` instead of the full suite, and skips the remaining full-suite-only steps that aren't needed for test evidence (e.g. e2e/build/package/binary) — decide and document; lint/typecheck may stay;
   - the non-win32 legs are skipped (use a matrix/job `if` or step-level conditions; prefer the simplest that keeps the job names stable).
   - Pass the input through an `env:` variable, NOT by interpolating `${{ inputs.win32_test_filter }}` directly into the `run:` script (script-injection safety). Validate it in shell (allow only path-ish characters `[A-Za-z0-9_./*-]` and spaces; fail otherwise).
   - Use `shell: bash` for that step (Git Bash is available on windows-latest).
3. Without the input (push/pull_request/dispatch with empty filter) behavior is unchanged.
4. Extend `scripts/__tests__/release-workflow.test.ts` (it already parses ci.yml and asserts `on`, `concurrency`, `continue-on-error`, `timeout-minutes`, win32 matrix entry) to assert the new input, the env-passing (no direct `${{ inputs.` inside run scripts), and the conditional behavior.
5. Document the usage in `docs/12-open-source-distribution.md` next to the existing "win32 informational until item 9" note, with the exact command:
   `gh workflow run CI --ref <branch> -f win32_test_filter="packages/x/src/__tests__/a.test.ts ..."`
   and add a short note under todo.md item 9 near the 2026-09-14 informational note (no checkbox tick needed unless one matches exactly).
NOTE: unit W1-1 may edit the ci.yml test step in parallel (per-file progress runner). Keep your change structured so a merge is easy; controller resolves conflicts.

## Acceptance
- `bun test scripts/__tests__/release-workflow.test.ts` passes; `bun run typecheck && bun run lint` pass.
- If `actionlint` is available locally, run it on ci.yml (optional; don't install new global tools).
- Report: .superpowers/sdd/2026-09-15-remaining-work-waves/W1-4-report.md

---

# W1 outcome — 2026-09-16 (cloud session)

| Unit | PR | Result |
|---|---|---|
| controller | #15 | merged `95dff55` — items 2 and 18 closed, 9k/18 CI evidence |
| W1-1 | #17 | merged `5ba0aa6` — macOS hang, F1, both Intel supervisor failures |
| W1-4 | #16 | open, refreshed onto main |
| W1-2 | #18 | open, refreshed onto main |
| W1-3 | #19 | open, refreshed onto main |

## What the wave actually found

Three of the four units turned out to be production bugs rather than test timing, and in two cases
the handoff note's own diagnosis was wrong:

- **The macOS hang was not "the 16th file after render-homebrew-formula".** Bun streams output per
  line, so the last line printed *is* where it stopped: run `34897205539` stops *inside*
  `render-homebrew-formula.test.ts` on its 18th test, which ran `spawnSync('/usr/bin/ruby', …)` with
  no timeout. macOS's `/usr/bin/ruby` is a developer-tools shim that can block forever, and
  `spawnSync` holds the very thread Bun's `--timeout` fires on. Proven fixed: both darwin legs of
  PR #17 ran all 234 files, 234 starts matched by 234 ends, darwin x64's test step in 6m47s.
- **F1 was a wrong security predicate**, not a timing test: `nlink === 1` refused a descriptor
  legitimately showing `nlink === 0` during the anchor's rename-replace. Relaxed on POSIX only.
- **F2's root cause was confirmed from a CI log, not inferred.** Run `34896095080` records both `ps`
  columns hashing to `sha256("(node)")` with `commandBytes: 6`, with `processStartTime` and `pgid`
  identical in every reading — which empirically rules out start-time granularity, clock resolution
  and pid reuse.
- **W1-3's brief suggested the wrong fix.** Propagating `--import tsx` would have reintroduced a
  hang (tsx's hooks leave an `esbuild --service` child inside the anchor's detached group, which then
  cannot drain — a finding already recorded in `testkit/src/runtime-invocation.ts`). The loader is
  replaced with an in-thread resolver instead.
- **`process-supervisor.test.ts:308` had never evaluated anything.** Under `bun run test` the test
  process was not a process-group leader, so both sides of the assertion were `{status:'absent'}`.
  The per-file runner spawns each file detached, which made the group real — and the assertion
  racy — for the first time.

## Decisions taken in this session

- **Decision: unit branches are not deleted after merge** — this environment's proxy refuses
  `DELETE` on `git/refs` (403 "Write access to this GitHub API path is not permitted") and
  `git push --delete` is rejected too. Why: no other route exists from here. Cost if wrong: merged
  branches accumulate on the remote and someone has to prune them by hand.
- **Decision: the W1-4/W1-1 merge-order ruling was void.** The ledger ordered W1-4 first because
  both were expected to touch `ci.yml`; W1-1's fix turned out to need no `ci.yml` change at all (the
  runner is wired into `package.json`), so W1-1 merged first instead, to give the other three
  branches a CI that does not hang. Cost if wrong: nil — the merge was verified conflict-free.
- **Decision: local gates were not re-run after refreshing a branch onto main.** Each branch was
  gated before its PR; the refresh only adds main, and CI runs the same gate on four platforms,
  which is strictly stronger than one Linux run. Cost if wrong: a conflict-induced failure surfaces
  in CI rather than locally, costing one CI cycle.
- **Decision: no third review round for W1-1.** Round 2 consisted entirely of the reviewer's own
  pre-approved follow-up list, each item closed with its reasoning. Cost if wrong: the guard's
  regex-vs-division lexer heuristic misreads an unusual expression and under-detects; the shapes
  that would trip it are pinned in its own fixture.
- **`gh` is not installed in this environment**, and raw Actions log downloads are proxy-blocked
  (`blob.core.windows.net` → 403 CONNECT). GitHub is read through the MCP tools and the REST API.
  Re-running a failed job is **not** permitted to this token (403 on `rerun-failed-jobs`); a branch
  is refreshed onto main instead, which is a real commit rather than an empty one.

## Follow-up units this wave recorded but did not do

1. **A `raceHook` phase between the `open` and the `fstat`** in `openSafeLog`/`openExistingSafeLog`
   (`packages/daemon/src/logs.ts`). Closes both the one untested `nlink === 0` branch and the lack of
   a deterministic F1 reproduction. Agreed by implementer and reviewer; excluded because threading
   the hook through two free functions is more churn than the fix it would test.
2. **Make the repo erasable, and lint for it.** Erasable TypeScript is now load-bearing for the
   private-runner module graph, and three modules already violate it with parameter properties:
   `packages/platform/src/service/errors.ts`, `packages/core/src/state/ci.ts`,
   `packages/core/src/analysis/worktree-reclaimable.ts`. The first makes the whole `@wtm/platform`
   barrel unloadable under the hooks, so adding one barrel import to `process-anchor.ts` would break
   every queued job. A test guards the runner graph transitively; there is no lint rule. Doing this
   would also make the source-launched `wtm daemon install` unit actually start.
3. **The third `defaultRuntimeInvocation()` copy** in `packages/core/src/plan/external-adapter.ts`,
   with the same defect and a layering violation (core reading `process.*`). Needs the invocation
   injected from the composition layer; collapse `cli/src/main.ts`'s duplicate `RuntimeInvocation`
   type onto the platform one at the same time.
4. **Two unconfirmed identity re-reads in `process-supervisor.ts`**: the single-read `mismatch` at
   `:750` and the post-retry re-identification at `:596`, neither following `waitForIdentity`'s
   two-agreeing-reads rule. Cite the run-`34896095080` trace. Moderate priority: W1-2 narrowed the
   window, it did not close it.
5. **A real SEA smoke in the gate**, so `sea-smoke`'s ten cases stop skipping for want of a built
   executable.

## Environment notes for the next session

- Host is Linux. macOS-specific tests do not run locally; darwin evidence comes from CI.
- Local bun is 1.3.11; the repo pins 1.3.14. Host `node` is v22 but the daemon requires >= 24 —
  prepend `/opt/nvm/versions/node/v24.21.0/bin` to `PATH` for daemon scenario tests.
- This sandbox runs as **root**, so four test files fail on any branch, including the merge base:
  `cli/__tests__/reconcile-fallback`, `daemon/__tests__/main`, `daemon/__tests__/process-anchor`,
  `daemon/__tests__/server.integration`. Several of their tests refuse uid 0 outright. Compare any
  gate result against the merge base before calling a failure a regression.
