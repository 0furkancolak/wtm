# Independent review and native follow-up — 2026-09-10

Baseline: `75a8626` on `codex/todo-safety-docs-parity`, with a clean working tree.
This continues the endpoint/RAM/readiness wave; it does not replace its historical ledger.
Root owns integration and all heavy commands, with at most two active subagents. Push is
authorized; PR, merge, release, signing credentials and package publication are not implied.

## Native baseline

[CI run 34457543774](https://github.com/0furkancolak/wtm/actions/runs/34457543774):

- Linux x64: 1627 passed, 0 failed, 15 existing skips. E2E 3/0 and binary smoke 10/0;
  lint, typecheck, build and package verification passed.
- macOS ARM64: 1631 passed, 0 failed, 11 existing skips. E2E 3/0 and binary smoke 10/0;
  the other CI gates passed.
- macOS x64: 1629 passed, 2 failed, 11 existing skips. Later gates did not run.
  The failures were a raw log-file read during rotation and a stale managed identity during
  the production CLI start/ps/stop scenario. The latter cause is not established.
- Windows x64: 1327 passed, 115 failed, 200 skipped and one between-tests error; 2539.90 s.
  Install/lint/typecheck passed; later gates did not run. Compared by unique failure name
  with the saved f37a160 run, 102 failures were common, 13 new and five no longer failed.
  Twenty-three starts reported LOG_SETUP_FAILED: the anchor still imposed POSIX 0700 on
  Windows. Fixture application-data isolation and custom pipe addresses also had concrete
  defects. These are product/test issues, not a blanket environment classification.

These results apply to the baseline, not uncommitted follow-up code. The new native RAM
policy-on worker scenario below is distinct from the earlier config/SQLite composition test.

## Review findings and decisions

Independent RAM admission and HTTP readiness observer/controller reviews found no defects.
The real two-AI memory experiment is still unavailable: this container is not the user's
machine, and its measurements cannot explain Claude's memory use or prove savings.

1. **UDP descriptors:** the private helper left failed bind sockets open. An independent
   reproduction observed 256 occupied probes increasing descriptors from 20 to 276. Under
   a 128-descriptor child limit, 255 occupied candidates made the final free port appear busy.
   Both helper implementations now await failed-socket close before moving to the next
   candidate. The actual private CLI regression failed before the fix and passes after it.
   Windows exercises the full sequence but does not claim the POSIX descriptor-limit proof.
2. **Recovery during rotation:** current stdout can legitimately be absent between rename
   and reopen. Recovery now verifies the existing safe current inode normally, using the
   existing three-attempt generation reader only for missing/current-identity races. It
   reads at most one payload byte and creates or truncates nothing. Five real-filesystem
   regressions cover archived/shifted/legacy phases, an unsafe archive and bounded refusal
   of continuously changing evidence. The native writer fixture pauses through a task-owned
   sentinel before raw size assertions; its live recovery and size assertions remain.
3. **Same-device mounts:** device IDs do not identify Linux bind mounts. A bounded platform
   reader observes mountinfo before/after the core walk. It excludes strict descendants,
   keeps a mount-root worktree measurable, and invalidates changed relevant evidence.
   Missing/malformed evidence stays unknown. Limits are 1 MiB/20,000 records per snapshot
   within the report's existing cooperative time budget. `excluded.mounts` is separate from
   `crossDevice`; no migration or removal-policy change is needed.
   Review caught an initial core platform dependency, reproduced by the existing architecture
   guard. The reader moved to `@wtm/platform`; CLI selects/injects it and core accepts only a
   capability. No guard exception was added. Thirteen fixture scenarios use real files with
   substituted kernel evidence, not native mount creation. Same-device coverage is Linux-only;
   transient mount ABA and atomic filesystem snapshots remain outside the guarantee.
4. **Native identity diagnosis:** the failing composition fixture now keeps a failure-only
   ring of the actual inspection/group/signal observations, expected identity, first mismatch,
   terminal state and authenticated completion. Darwin evidence hashes command/comm from
   the same ps invocation; argv and environment are not logged. No identity check, signal
   policy or timeout changed. A new CI occurrence is needed to determine the root cause.

The other subagent reviewed the log/diagnostic changes without findings; the first reviewer
verified the UDP repair, revised mount seam and native RAM scenario without further findings.

## Native RAM policy-on scenario

The existing two-CLI/two-repository workflow now has a second mode with concurrency 2,
configured memory budget 64 MiB, and a 64 MiB estimate per task. One task must run while the
other reports `memory_budget`, then both must produce one start/end, exit 0, released slots
and unchanged source evidence. The actual task also logs the queue-only worker setting.
Memory sampling uses production readers. The configured numbers make admission observable;
they are not measured task RSS or an enforced RAM limit. External barrier files keep the
task sources frozen. The native test is part of the normal suite and existing E2E command.

Local execution failed at Unix socket `listen EPERM` before any task launched. The test was
not skipped or relaxed. Earlier native anchor execution also failed before task startup with
`ANCHOR_HANDSHAKE_INVALID`; numeric PID visibility here is not reliable identity evidence.

## Verification

Commands run sequentially with Bun 1.3.14 and pinned Node 24.18.0:

- UDP regression: RED on final free port; GREEN 7/0 with existing batch tests.
- Log regressions: RED 0/5; GREEN complete log suite 26/0, 110 assertions.
- Mount initial regressions: RED 0/13; walker/ranking/mount group GREEN 44/0.
- Architecture guard: RED on platform literals; after moving the seam, CLI mount/ranking,
  private UDP and architecture checks GREEN 25/0.
- Queue memory/state, ignored content, UTF-8/parser, Git environment and CLI error contract:
  57/0 across nine files. Prior safety checks are preserved.
- Full typecheck passed after the seam and failure-trace integration.
- Standalone build passed; actual batch helper smoke without Node on PATH passed 1/0.
- New native RAM workflow: 0/1, pre-launch Unix socket EPERM as described above.

The prior full local suite/E2E/performance outcomes remain in the continuation ledger.
Targeted passes do not turn that earlier full run into a pass. Native Windows/Linux ARM64,
the macOS x64 identity failure, native mount mutation and real two-AI RAM evidence remain open.


## Frozen-tree broad run before Windows follow-up

`bun run test`: **1547 passed / 131 failed / 6 skipped**, 1684 tests in 197 files,
669.25 seconds. Against the previous local wave (1488/128/15), 127 failure names were shared.
The four newly failing names were the new native RAM workflow and three standalone checks.
RAM failed before launching a task on Unix `listen EPERM`. Standalone process ownership
failed at `ANCHOR_HANDSHAKE_INVALID`; standalone daemon IPC did not become available. The
embedded skill comparison used a previously built binary after the source skill changed;
a fresh binary build and targeted rerun are required. The reduced skips include binary
checks now enabled by a present binary. No new skip or weakened assertion was introduced.
The prior `persistent job CLI` contradictory-evidence failure did not recur.

This result is not green and does not cover the subsequent Windows follow-up. Full typecheck
passed immediately before the frozen-tree run. Documentation/Commander and example resolver
checks passed 11/0. See the separate Windows note for subsequent regression evidence.

## Final runtime verification

The frozen runtime/fixture tree and fresh standalone executable completed the full suite with
**1596/131/6**, 1733 tests, 203 files and 701.55 seconds. Lint, full package typecheck, standalone
build and `package:verify` passed. Rebuilt embedded skill parity passed in the full suite.

`test:e2e` finished **0/4**. Both job modes and HTTP readiness failed before task launch on Unix
socket `listen EPERM`. The removal scenario required a separate diagnosis: a temporary copy
emitting actual error envelopes showed the Bun-launched Node child reporting PID 15 with no
readable start identity, so it could not own a repository operation lease. The same scenario
launched directly through Node completed removal. The temporary diagnostic was deleted; neither
the production identity check nor the E2E expectations changed. Direct Node success does not
replace the failed Bun-driven E2E gate.

`test:perf` finished **19/2**. Idle daemon startup failed at Unix socket publication; the report
collector therefore did not produce its JSON file. Scale and source-storm checks passed, but
there is no complete current RAM/performance report and no real-user Claude measurement.

Subsequent release-script and distribution-document changes are verified as a separate slice;
they do not alter the runtime tree exercised by this broad run. Native Windows/PowerShell,
macOS Intel identity diagnosis and policy-on RAM workflow evidence still require native CI.
