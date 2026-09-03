# Increment C3 — a hang that cannot hide

## Status

Draft — 2026-09-03. A defect increment, opened by reading the CI run of C2's own closing commit.
Follows C2 (`2026-09-02-linux-in-ci.md`, closed at `66333ee`).

## Why this increment exists

C2 was reported complete on run `33657859156` (`ff2b416`), where all three legs were green. The
closing commit `66333ee` changed `todo.md` and a spec file and **no product code at all**. Its own
run, `33658769131`, went:

| leg | result |
| --- | --- |
| Validate linux x64 | success |
| Validate darwin x64 | success |
| **Validate darwin arm64** | **cancelled at the 30-minute job timeout** |

The suite stopped after `packages/cli/src/__tests__/remove-runtime.test.ts`'s second test and
produced nothing for 29 minutes 31 seconds, until GitHub killed the job and reaped an orphan
`bun`. Identical code had passed the same leg on the previous commit.

So this is the F15 rule (*an increment is not reported complete until its CI run is read*) being
useful one commit after it was written, and it is the sixth instance of the shape C2 named: **a
claim that was true of the only instance anyone had checked.** The claim this time was
`scenario-child.ts`'s own docstring, which asserts that `scenarioTimeoutMs` bounds a hung
scenario. It does not.

## The claim this increment makes

**A scenario child that will not die cannot cost more than its deadline, and it fails one named
test instead of stopping the run.**

## Findings

### F1 — `spawnSync`'s `timeout` is a request, not a bound

Node's `spawnSync(..., { timeout })` sends `killSignal` — **`SIGTERM` by default** — and then keeps
waiting for the child. It does not give up. A child that does not die on `SIGTERM` therefore makes
`spawnSync` block for as long as whatever is above it will wait.

Measured on this host (darwin arm64, macOS 26.6.2), against a child that installs an empty
`SIGTERM` handler:

| child | `killSignal` | `spawnSync` returned after |
| --- | --- | --- |
| SIGTERM-deaf | `SIGTERM` (default) | **never** — still blocked when killed externally at 25s |
| SIGTERM-deaf | `SIGKILL` | 2004 ms (deadline 2000 ms) |
| SIGTERM-deaf, plus a grandchild holding the inherited stdout pipe | `SIGKILL` | 2005 ms |

Two things this rules out, both of which were plausible before the measurement:

- **It is not the grandchild-holds-the-pipe stall.** A surviving grandchild on the inherited
  stdout pipe did not delay the return by a millisecond. This was the first hypothesis and it was
  wrong.
- **It is not specific to any one scenario.** Any SIGTERM-deaf child does it.

`SIGKILL` cannot be caught or ignored, which is exactly why substituting it turns the deadline
into a bound.

### F2 — the per-test timeout cannot cover for it

`bun run test --timeout 60000` sets a per-test deadline, and CI relies on it: the workflow comment
at `.github/workflows/ci.yml:50` says so in as many words. It cannot fire here. `spawnSync` blocks
the thread the runner is on, so the runner never regains control to enforce anything. Both guards
in place on the failing job were requests; neither was a bound.

### F3 — the deadline is spelled out at every call site, so it can be half-applied

`scenarioTimeoutMs` has 41 call sites across 30 test files, each independently writing
`{ timeout: scenarioTimeoutMs, encoding: 'utf8' }`. Nothing makes a new one carry the deadline, and
— the point of this increment — nothing would make a new one carry `killSignal` either.

That count undersold the actual exposure. Six more call sites hardcode their own shorter deadline
(`server.integration.test.ts` at 10s, three in `runtime-factory.test.ts` and one each in
`task-resolution.test.ts` and `main.test.ts` at 15–30s) instead of importing the constant, so a
search for `scenarioTimeoutMs` does not find them. And `scripts/performance-report.ts` carried a
private copy of the entire pattern — its own `runScenario` function, its own 120 s deadline, its own
comment describing "forty minutes of a job doing nothing" almost word for word — which means the
mitigation this file's docstring describes was applied in one place and then reinvented, not reused,
somewhere else in the tree. A fix applied by hand at every call site is a fix that erodes; this is
what the erosion looked like before it was measured.

### F4 — the docstring already knew, and had already been wrong twice

`packages/testkit/src/scenario-child.ts` opens by describing this exact failure: *"a child that
never exits does not fail its test — it stops the entire run… Twice this took a release job past
forty minutes."* The response was to add `scenarioTimeoutMs`. That mitigation was never tested
against a child that resists `SIGTERM`, so the module documents the hazard and does not prevent it.
This is the third occurrence, and the first two are already recorded in that comment.

### F5 — the codebase knows the general fact in one place already

`packages/core/src/git/git-runner.ts:180` carries the comment *"A process blocked in an
uninterruptible open() ignores SIGTERM, so the escalation is…"* and escalates. The product code
learned this; the test harness did not. `packages/daemon/src/process-anchor.ts:256` is itself a
deliberate `process.on('SIGTERM', () => {})` — WTM ships a SIGTERM-deaf process on purpose.

## Decisions

- **D1 — `killSignal: 'SIGKILL'` for scenario children.** Measured in F1. The deadline is only ever
  reached by a scenario that is already broken, so nothing is lost by denying it a graceful exit.
- **D2 — one helper, not 41 edits.** `runScenario` in `packages/testkit/src/scenario-child.ts`
  applies the deadline and the kill signal, and every call site goes through it. The bound stops
  being something a call site can forget.
- **D3 — a timed-out scenario fails loudly and by name.** On `ETIMEDOUT` the helper throws with the
  command, the scenario argument, the deadline, and whatever the child managed to write first.
  Today a timed-out child returns `status: null`, which reaches the assertion as a confusing
  `expect(result.status).toBe(0)` diff that never mentions time.
- **D4 — the bound is measured in the suite, on every platform, every run.** F1's table becomes a
  test: a deliberately SIGTERM-deaf child, run through the helper with a short deadline, asserted
  to return inside it. This is the same discipline C2 applied to `sizeof(sun_path)` and inode
  reuse — the platform fact is re-checked rather than quoted.
- **D5 — a structural guard keeps the pattern from coming back.** A test fails if any file under a
  `__tests__` directory calls `spawnSync` on a scenario path without going through the helper,
  the way `platform-independence.test.ts` guards the platform seam. Non-scenario `spawnSync` uses
  (`git`, `plutil`, `npm pack`, `ruby -c`) are a reviewed allowlist.
- **D6 — the helper stays synchronous.** Converting 41 sites to `async` is a larger, riskier change
  than the defect warrants, and F1 shows it is not required: `SIGKILL` bounds the synchronous call.
  The per-test timeout still cannot fire during a scenario, which D3's message compensates for by
  making the one failure it does produce self-explanatory.
- **D7 — orphaned grandchildren are out of scope.** `SIGKILL` reaches the child, not its group.
  F1 measured that a surviving grandchild costs nothing in wall-clock, and the CI runner reaps
  them at job cleanup. Killing the process group needs `detached: true` at every call site and a
  negative-pid signal the synchronous path cannot send after the fact; it is worth doing only if
  something is later shown to leak across tests rather than across the job.

## What this increment does not claim

- **Not a diagnosis of which process hung.** The log ends mid-file with no stack, and the run is
  gone. This increment makes the *next* occurrence name itself (D3) rather than guessing at this
  one. That is deliberate: a fix aimed at a guessed culprit would be the same mistake again.
- **Not that `remove-runtime.test.ts` is now reliable.** If it hangs again it will fail in seconds
  with a message, which is the precondition for diagnosing it — not the diagnosis.
- **Not an async test harness.** D6.

## Acceptance criteria

1. `runScenario` exists in `packages/testkit/src/scenario-child.ts`, applies `scenarioTimeoutMs`
   and `killSignal: 'SIGKILL'`, and is exported from `packages/testkit/src/index.ts`.
2. A test spawns a SIGTERM-deaf child through it and proves the call returns inside the deadline.
   The test fails if `killSignal` is reverted to the default.
3. All 41 scenario call sites go through the helper; no `__tests__` file passes
   `timeout: scenarioTimeoutMs` to `spawnSync` directly.
4. A timed-out scenario produces a message naming the command, the case, and the deadline.
5. The structural guard fails when a raw scenario `spawnSync` is reintroduced.
6. `lint`, `typecheck`, `test`, `test:e2e`, `build`, `package:verify`, `binary:verify` pass locally.
7. **The CI run for the commit is read, on all three legs, before the increment is called done.**

## Outcome

All seven criteria met, with the scope widened by F3's revision:

1. `runScenario` (`packages/testkit/src/scenario-child.ts`) applies `scenarioTimeoutMs` (or a
   caller-supplied `timeoutMs`) and `killSignal: 'SIGKILL'`, and is exported from
   `packages/testkit/src/index.ts` alongside `RunScenarioOptions`.
2. `packages/testkit/src/__tests__/scenario-child.test.ts`, driving
   `packages/testkit/src/__tests__/scenario-bound.child.ts`, spawns a SIGTERM-deaf child through
   `runScenario` and proves three things measured, not asserted from memory: the call returns
   inside its deadline, the thrown message names the deadline, and the same deadline with the
   default kill signal does not return at all (it needed an outer, hand-written `SIGKILL` bound to
   end the measurement itself, which is F1's table turned into an assertion).
3. Every call site found — the original 41, the 6 with their own hardcoded deadline, the nested
   spawn in `remove-lease-conflict.scenario.ts`, and `scripts/performance-report.ts`'s private copy
   of the whole pattern — now goes through `runScenario`. 39 files changed.
4. A timed-out scenario throws `scenario did not finish inside ${timeoutMs}ms and was killed:
   ${commandLine}`.
5. `packages/testkit/src/__tests__/scenario-guard.test.ts` fails on any `__tests__`/`.scenario.ts`
   file that calls `spawnSync('node' | 'bun' | process.execPath, ...)` outside `runScenario`, with a
   six-entry reviewed allowlist (each entry one line, one reason) for the calls that are not this
   hazard: the two files that measure the mechanism itself, the benchmark bundle/run in
   `idle-daemon.scenario.ts` (bounded transitively by its own caller's `runScenario`, per D7), and
   `package-contents.test.ts`'s build step.
6. All seven gates passed locally: `lint`, `typecheck`, 1237 tests (1 skip, 0 fail) in `test`,
   `test:e2e`, `build`, `package:verify`, and `binary:verify` (`dist/sea/wtm 0.1.0-rc.1, darwin-arm64`,
   9/9 smoke tests). `remove-runtime.test.ts` itself: 10/10 in 7.4s.
7. CI run pending at the time this section is written — read before the increment is announced
   complete, per its own rule.

Not fixed, and deliberately: `packages/core/src/runtime/endpoints.ts`'s production port probe
(`spawnSync(process.execPath, ['-e', probeScript, ...])`) is the same call shape but is runtime
code, not test harness — `core` cannot depend on `@wtm/testkit`, and a hang there is a product
question (the daemon's own probe), not this defect. Out of scope, not overlooked.
