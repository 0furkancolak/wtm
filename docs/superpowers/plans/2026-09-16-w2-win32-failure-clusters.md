# win32 (Windows x64) failure clustering — runs `34873813789` and `34947190062`

| | run `34873813789` | run `34947190062` |
|---|---|---|
| win32 job id | `104075931882` | `104316798785` |
| conclusion | cancelled | cancelled |
| commit fetched (checkout) | `5e56c18385efffb1373c831cf874092befef44dd` | `360a7daf2d945a8bb8724e5cefa3128d416cb76b` |
| `bun run test --timeout 300000` started | 2026-09-14 17:19:32Z | 2026-09-15 08:55:44Z |
| `##[error]The operation was canceled.` | 2026-09-14 18:17:20Z (~58 min of test time; job hit the 60 min job cap) | 2026-09-15 09:19:02Z (~23 min; job hit the 25 min cap) |
| last test file the log shows | `packages/cli/src/commands/__tests__/gc.test.ts` (cut immediately after its last `(pass)` line) | `packages/daemon/src/__tests__/heavy-job-native-lifecycle.test.ts` (cut after its first `(fail)`) |
| test files that produced output | 107 of 218 | 63 of 218 |
| distinct failing test files | 25 (80 `(fail)` lines) | 17 (26 `(fail)` lines) |

Both logs were read in full (3872 and 1813 lines); neither run printed a Bun summary line, because both were killed mid-run.

Cluster wording is taken verbatim from `docs/superpowers/plans/2026-09-15-remaining-work-waves.md` (the W2–W4 tables). `todo.md` item 9 itself does not carry lettered sub-items 9a–9i; that same file also records "Not: 9a–9h kümeleri `34873813789` loglarından doğrulanmadı" — this document is that verification.

---

## 9a — DaemonClient frame decoder takılmaları (300 sn beklemeler)

- `packages/cli/src/__tests__/client.test.ts`
  - `DaemonClient > uses a fresh frame decoder after a partial frame corrupts the first connection` → 300s per-test timeout (301036ms run 1 / 301042ms run 2), then `Received promise that rejected`
  - `DaemonClient > reconnects immediately with a fresh decoder after an oversized frame header` → 300s per-test timeout (301027ms / 301041ms), same rejection

These two tests alone burn ~10 minutes of every win32 run and reproduce identically in both runs.

**Resolved 2026-09-16 (W2-1), with a residue that is not W2-1's.** The 300 s was never the test
body: it failed in 1035 ms (run 1) / 1033 ms (run 2), and Bun charges the rest to the hook —
`^ a beforeEach/afterEach hook timed out for this test`. `cleanups` drain reversed, so
`DaemonClient.close()` runs first and that is where the 300 s sat: it awaited `'close'` after
`destroy()` with no bound. Two sibling unbounded waits were found alongside it — `#connect()`
listened for `connect`/`error` only, so a peer that closes without an error settled nothing, and it
carried no connect deadline at all. All three are now bounded by `transportTimeoutMs`
(`packages/cli/src/client.ts`). That is a production fix: on a wedged transport `wtm` could not
exit.

**Residue, owner 9b.** The ~1 s body failure is a real win32 transport defect that is still
unexplained and is now, deliberately, uncovered on win32. State it precisely: it is **not** "a
second connection to one named-pipe address is not served" — `readiness-transport.test.ts > scope`
**passes** on win32 (run 1, 271 ms) and holds a second *concurrent* client on the same pipe. It is
specifically a **re-connect after the first pipe instance was torn down mid-frame**: the reconnect's
`connect` fires, the request is written, and no answer arrives within the client's 1 s bound. The
client is exonerated — the same two cases pass against a scripted transport, and the merge-base
real-transport tests pass unchanged against the new client on POSIX — so this is the transport, not
the decoder. The real-transport reconnect tests are kept in `client.test.ts` under
`test.skipIf(process.platform === 'win32')`, so the other four legs still prove the reconnect and
the handoff cannot evaporate.

**Warning for whoever takes 9b:** this will not reach you through 9b's file list. 9b's stated code
area is `packages/platform/src/ipc/*`, but nothing in this failure goes through it — it is plain
`node:net` named-pipe reconnect, exercised by the fixture server in
`packages/cli/src/__tests__/client.test.ts` and by `packages/daemon/src/server.ts`. Add those
explicitly, and unskip the two `reconnects over a real transport ...` tests as the acceptance check.
One more pointer, offered as a lead and not as a diagnosis: `server.ts:309`'s `socket.end()` was
examined during 9a and deliberately left alone. Nothing in these logs measures whether the bytes
written immediately before it are delivered on win32, so if the reconnect turns out to lose the tail
of a frame, that call is where to look first — but no evidence gathered here implicates it.

## 9b — named pipe IPC sunucu ve istemci

- `packages/testkit/src/__tests__/ipc-address.test.ts` (run 1 only)
  - `a real fixture endpoint answers, closes, and can be bound again at the same address` → 300s timeout (300002ms). The two pure-string tests above it pass, so it is the actual bind/close/rebind on a named pipe that hangs.
- `packages/daemon/src/__tests__/runtime-factory.test.ts` (run 1)
  - `production daemon composition > runs CLI start, ps, and stop through a real temporary socket and SQLite store` → scenario killed at 20000ms
  - `production daemon composition > default CLI client reaches the isolated production IPC address without runtime injection` → scenario killed at 20000ms
  - `production daemon composition > closing the daemon releases control handles while a detached task remains live` → `Scenario exit watchdog expired` (15009ms)
  - `production daemon composition > uses the private custom database parent rather than only the data root` → `private-database.scenario.ts` killed at 20000ms
- `packages/cli/src/commands/__tests__/daemon.test.ts` (run 1)
  - `daemon CLI surface > wires serve to the production runtime factory and closes its real socket on SIGTERM` → `Condition timed out` (10029ms)
  - `daemon failure output > an over-long HOME refuses serve with one coded line naming the length and the limit` → `fixture did not land one byte past the socket path limit` (the POSIX `sun_path` limit has no named-pipe equivalent)
- `packages/daemon/src/__tests__/main.test.ts` (run 1)
  - `WtmDaemon startup > recovers state, then answers, and only then reads every repository` → `main.scenario.ts startup-order` killed at 15000ms (daemon never answered)
- `packages/cli/src/__tests__/create-daemon-running.test.ts` (run 2)
  - `a running daemon dispatches worktree.created and applies [prepare] mode for wtm create` → scenario killed at 30000ms
- `packages/cli/src/__tests__/readiness-workflow.test.ts` (both runs)
  - `managed HTTP readiness uses real CLI, daemon, owner identity and service lifecycle` → scenario killed at 30000ms
- `packages/cli/src/__tests__/full-workflow.test.ts` (run 2)
  - `runs the complete release safety workflow in an isolated local fixture` → scenario killed by SIGTERM at 30000ms

Note on the last three: they are composite end-to-end scenarios that need a live daemon over the pipe transport *plus* supervisor (9d) and queue (9e) behaviour. They are listed here because nothing in them can start until the transport answers, but they are not proof of 9b alone.

## 9c — ManagedLogStore'da her çağrıda powershell.exe başlatan ACL kontrollerini toplu ya da kalıcı bir oturuma taşı

- `packages/daemon/src/__tests__/logs.test.ts` (run 1) — **no failures, but this is the strongest evidence in the log**
  - `ManagedLogStore > reads crash-left rotation phases without skipping or duplicating cursor bytes` → passes in 243630ms
  - `ManagedLogStore > rotates at the configured bound and retains only the configured generations` → passes in 117887ms
  - `ManagedLogStore > retries when rotation archives current after the marker sample but before segment open` → 50701ms; `recovery refuses continuously changing rotation evidence after a bounded observation` → 39938ms; `reads each byte after a generation cursor once across close-and-rename rotation` → 38995ms; `recovery verifies the archived stream during the writer reopen gap: rotating-4242-123456` → 35580ms; plus ~6 more tests in the 19–32s band.
  - The log shows `…\PowerShell\7\pwsh.EXE -command` invocations from the trust path; a single file consuming >10 minutes of the 25-minute budget is why later files never run.
- `packages/daemon/src/__tests__/anchor-log-trust.test.ts` (both runs)
  - `a parent swap while ACL authorization waits cannot publish into the replacement directory` → `error: ANCHOR_LOG_CLOSED` (22ms / 28ms). The two neighbouring Windows-ACL tests pass, so the failure is specifically the swap-while-authorization-is-in-flight window.
- `packages/daemon/src/__tests__/main.test.ts` (run 1)
  - `WtmDaemon startup > names the privacy grant only for a directory that exists and refuses to open` → expected `could not be opened either (EACCES)`, received the "every git command overran its bound, twice, although the directories themselves open normally" message. Low-confidence assignment: the fixture denies read access POSIX-style and Windows ACLs do not deny it, so the daemon falls into the slow-filesystem branch. It touches the same permission/ACL seam as 9c, but if W2-2 does not take it, it belongs with 9g's POSIX-assumption failures.

## 9d — supervisor ve anchor (CreationDate kimliği, `taskkill /T`)

- `packages/daemon/src/__tests__/process-supervisor.test.ts` (run 1, 28 failures — the single biggest cluster)
  - 24 of them fail with `ManagedProcessError: Managed task could not be started.` — e.g. `stopping a task terminates its entire owned process group`, `concurrent singleton starts serialize and return one live record`, `natural child exit updates state and preserves direct file logs`, `anchor-owned writers rotate a fast stream without gaps or duplicate bytes`, the eight `replacement anchor finishes partial retained-generation shift …` cases (each 33–36s), `task leader exit leaves the anchor and record running until its descendant exits`, `TERM-honoring task leader with TERM-ignoring descendant escalates through the verified anchor`, `TERM-ignoring groups are KILLed only after an immediate identity recheck`, `daemon recovery verifies stored identities without adopting them`, `recovery releases a crash-left lease for a verified live RUNNING anchor`, `recovery never releases a different owner token for a live RUNNING anchor`, `reclaims only an expired restart lease tied to the exact verified old process`, `does not reclaim an expired ordinary start lease from a verified live process`, `recovery promotes a launch-acknowledged STARTING anchor and releases its matching lease`, `a command that exits before identity inspection still gets a terminal non-signalable record`
  - 3 fail with `ManagedProcessError: Managed task cleanup requires recovery.` — `restart holds ownership across stop and start against a competing supervisor`, `recovery terminates a verified live cleanup-owned FAILED anchor and releases its lease`, `daemon close leaves the anchor-owned writer rotating while recovery remains read-only`
  - `pre-identity inspection failure retains durable cleanup ownership when ABORT is refused` → `error: Condition timed out` (14126ms)
  - `the daemon default process readers are this host's platform port > delegate to the port the platform seam selected, not to a hardcoded macOS one` → `expect(received).toEqual(expected)`
  - `RUNNING transition failure kills the group and terminalizes the created row` → failure without a distinct message
- `packages/daemon/src/__tests__/process-anchor.test.ts` (run 1)
  - `the supervisor tells the anchor the platform it selected > names its own selection when nothing is injected` → `ENOENT … wtm-anchor-spec-*\spec.json` (anchor never wrote its spec)
  - `… > names an injected platform, so a daemon built for one platform cannot spawn an anchor speaking another` → same `ENOENT … spec.json`
  - `process anchor runtime invocation > starts and stops through the injected executable without resolving a runtime from PATH` → `ManagedProcessError` / `RUNTIME_START_FAILED`, `reason: ANCHOR_HANDSHAKE_INVALID`, `spawnOutcome: "cleaned"` (17117ms)
  - `the anchor reads a process exactly as the platform port reads it > treats a /proc entry it may not read as not a member, rather than failing the scan` → `toEqual` diff, an extra member `13` in the received set (the `/proc` fixture has no Windows meaning)
- `packages/daemon/src/__tests__/anchor-deadline.test.ts` (both runs)
  - `an anchor whose READY-to-GO handshake consumes its deadline never spawns the task` → `Matcher error: received value must be a non-null object` (10557ms / 11532ms) — the anchor produced nothing to match against
- `packages/daemon/src/__tests__/completion-path-identity.test.ts` (run 1)
  - `refuses persistent marker identity churn at the existing three-attempt bound` → `ERR_ASSERTION actual: 5, expected: 3` (attempt bound overshoots on Windows)
- `packages/daemon/src/__tests__/daemon-restart-recovery.test.ts` (run 2)
  - `a fresh daemon generation recovers a live task and a task that exited while it was down, from the same durable database` → scenario killed at 30000ms
- `packages/testkit/src/__tests__/scenario-child.test.ts` (run 1)
  - `a scenario child that will not die on SIGTERM > would not have been ended by the same deadline with the default kill signal` → `Expected: false, Received: true`; on Windows the "TERM-ignoring" child dies anyway, so the fixture that the supervisor's escalation tests depend on does not hold.

## 9e — heavy-job süreç ağacı temizliği; 50d native kanıtı

- `packages/daemon/src/__tests__/heavy-job-native-lifecycle.test.ts` (4 failures run 1, 1 before the cut in run 2)
  - `native heavy-job cancel preserves evidence and releases the complete process tree` → scenario killed at 30000ms (both runs)
  - `native heavy-job timeout preserves evidence and releases the complete process tree` → scenario killed at 30000ms
  - `native heavy-job restart-running preserves evidence and releases the complete process tree` → scenario killed at 30000ms
  - `native heavy-job completed-during-downtime preserves evidence and releases the complete process tree` → scenario killed at 30000ms
- `packages/cli/src/__tests__/jobs-workflow.test.ts` (both runs)
  - `shares one daemon slot across independent CLI processes and repositories` → `jobs-workflow.scenario.ts was killed by SIGTERM` at 30000ms
  - `native queue memory admission holds a second repository despite two concurrency slots` → `jobs-workflow.scenario.ts memory was killed by SIGTERM` at 30000ms
- `packages/daemon/src/__tests__/idle-daemon.test.ts` (run 1)
  - `idle daemon release budget > emits machine-readable CPU p95 and RSS target semantics` → `idle-daemon.scenario.ts was killed by SIGTERM` at 30000ms

## 9f — Windows'ta SQLite/state yolu, disk ve gc hataları

- `packages/cli/src/commands/__tests__/gc.test.ts` (run 1 — the last file the log shows)
  - `disk and gc commands > reports logical and allocated totals split into owned and unknown records` → `ResourcePathGuardError: The current user identity is unavailable.` (`RESOURCE_PATH_DENIED`, thrown from `core/src/resources/guard.ts:187` `createResourceGuard`)
  - `disk and gc commands > counts worktree-local resources, which no sandbox record ever describes` → same
  - `disk and gc commands > reports no worktree-local usage as zero rather than leaving it out` → same
  - `disk and gc commands > gc command is dry-run by default and returns structured apply failures` → same
- `packages/cli/src/commands/__tests__/adapter.test.ts` (run 1)
  - `trusts an adapter in the production SQLite state database and lists it` → `Adapter trust command unexpectedly failed`, exit 1
  - `concurrent SQLite trust commands retain independent adapter records` → `Concurrent adapter trust commands unexpectedly failed`, exit 1
  - `creates the missing private WTM state parent before opening SQLite` → `ENOENT lstat 'C:\…\missing\WTM\state.db'` (errno -4058)
- `packages/daemon/src/__tests__/runtime-factory.test.ts` (run 1)
  - `the production factory measures against the selected platform > a path only macOS refuses is accepted under the Linux runtime` → `PrivateDirectoryError: WTM private directory is unavailable.` from `assertNoSymlinkComponents` (`core/src/state/private-directory.ts:131`)
  - `the production factory supervises through the runtime process port > recovery inspects through the injected platform runtime, not the host reader` → same `PrivateDirectoryError`
- `packages/cli/src/__tests__/daemon-status.test.ts` (both runs)
  - `daemon-status.json > round-trips through one private file` → `Expected: 384, Received: 438` (0o600 expected, 0o666 observed — the POSIX mode check has no Windows meaning)
- `packages/cli/src/__tests__/main.test.ts` (both runs)
  - `Commander CLI > wires adapter trust through the CLI with an injected SQLite database path` → exit code 1 instead of 0 (same SQLite-under-a-private-parent path as `adapter.test.ts`)
- `packages/cli/src/__tests__/remove-runtime.test.ts` (both runs)
  - `runtime-aware wtm remove > deletes the ephemeral resources it materialized instead of refusing over them` → received `errorCodes: ["RESOURCE_PATH_DENIED"]`, `exitCode: 3`, `worktreeExists: true` — the same resource-guard identity failure as `gc.test.ts`
- `packages/cli/src/__tests__/reconcile-fallback.test.ts` (both runs)
  - `a worktree created after \`wtm init\` > still ends in one coded envelope when the registry cannot be written at all` → `Expected: "WTM_NOT_INITIALIZED", Received: null` (21–24s); making the registry unwritable does not produce the coded refusal on Windows

## 9g — CLI yüzeyi testleri (`/bin/sh` bağımlılığı, `getuid` boşluğu)

- `packages/cli/src/__tests__/worktree-reclaimable-mounts.test.ts` (5 failures in both runs)
  - `worktree estimate respects Linux mount evidence: same-device-directory` → `ERR_ASSERTION actual: 12288, expected: 4096` (run 2 instead killed the scenario at 15000ms)
  - `… same-device-file` → `ERR_ASSERTION actual: 12288, expected: 4096`
  - `… escaped-path` → `ERR_ASSERTION actual: 12288, expected: 4096`
  - `… descendant-changed` → `ERR_ASSERTION actual: 'complete', expected: 'unavailable'`
  - `… ancestor-changed` → `ERR_ASSERTION actual: 'complete', expected: 'unavailable'`
  - The test name itself says "Linux mount evidence": block-size and `/proc/mounts` assumptions that Windows cannot satisfy.
- `packages/cli/src/__tests__/main.test.ts` (both runs)
  - `runProductionAnalyze without a selector > does not also run git worktree list for the shared selector it never uses` → `worktreeListInvocations` expected 2, received 0 — the shim `git` on `PATH` is never invoked
- `packages/cli/src/__tests__/refresh-remotes.test.ts` (both runs)
  - `--refresh-remotes > fetches once per repository rather than once per worktree` → `allFetches` 1→0 and `globalFetches` 3→0; same shim-never-runs signature
- `packages/cli/src/__tests__/remove-runtime.test.ts` (both runs)
  - `runtime-aware wtm remove > lets exactly one of two removing processes hold the repository` → `Error: timed out waiting for C:\…\wtm-conflict-shim-*\blocked` (32614ms)
  - `runtime-aware wtm remove > refuses the daemon's own lease acquisition while a CLI remove holds the repository` → `Error: timed out waiting for C:\…\wtm-daemon-conflict-shim-*\blocked` (32320ms)
  - Both wait on a file a shim executable should have written; the shim never runs.
- `packages/daemon/src/__tests__/ci-watch-scenario.test.ts` (run 2)
  - `ci watch follows a failing run through a fake gh and ci status reports it locally` → `ENOENT open 'C:\…\wtm-ci-watch-*\gh-calls.json'` (24133ms) — the fake `gh` shim never executed. Same root cause as the shims above, although the test lives in the daemon package rather than under `packages/cli/src/__tests__`.

## 9h — Windows path canonicalization, sürücü harfi/UNC, NTFS junction ve reparse point güvenliği

- `packages/cli/src/__tests__/forget.test.ts` (both runs)
  - `wtm forget > refuses a repository that is still on disk, and names the path that would do it` → expected the message to contain `Retiring a repository that exists`, received `C:\Users\RUNNER~1\AppData\Local\Temp\wtm-forget-… is still on disk. Retiring a workspace that exists …`. The selector `…\repo` did not match the stored repository, so `forget.ts` took the workspace branch; the received text also shows the 8.3 short form `RUNNER~1`, i.e. the selector path and the stored root are not canonicalized to the same string.
- `packages/testkit/src/__tests__/isolated-home.test.ts` (run 1)
  - `a real child inherits only fixture home and app-data locations without helper-created directories` → child scenario reporting `homedir()`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA` killed at 5000ms. Assigned here because it is the Windows home/app-data location resolution that the fixture isolates; if W3-3 does not want it, it is testkit infrastructure rather than product path code.

## 9i — Scheduled Task yaşam döngüsü, PowerShell install/uninstall ve completion, Git Bash testi

- `packages/cli/src/commands/__tests__/daemon.test.ts` (run 1)
  - `the published definition path > the CLI drives the selected backend rather than a hard-wired launchd one` → `ServiceLifecycleError: Task Scheduler uid must be a non-negative integer` (raised by `nonNegativeInteger` in `daemon/src/service-lifecycle.ts:2649`, reached from `platform/src/service/errors.ts`). Windows has no uid, so the Task Scheduler backend refuses to construct at all.

## Unassigned

Nothing was left unassigned. Three assignments are explicitly low-confidence and are flagged inline where they appear:

- `packages/daemon/src/__tests__/main.test.ts > names the privacy grant only for a directory that exists and refuses to open` — placed in 9c (permission/ACL seam); 9g is the alternative.
- `packages/testkit/src/__tests__/isolated-home.test.ts` — placed in 9h (Windows home/app-data resolution); it is testkit infrastructure, not product path code.
- `packages/daemon/src/__tests__/ci-watch-scenario.test.ts` — placed in 9g by root cause (shell shim never executes) even though 9g's stated code area is `packages/cli/src/__tests__/*`.
- The three composite e2e files (`full-workflow`, `readiness-workflow`, `create-daemon-running`) are placed in 9b because they cannot start without the transport, but they will also need 9d and 9e before they go green.

## Coverage gaps

Every one of 9a–9i has at least one concrete failure in these logs, but coverage is thin for several clusters because both runs were killed part-way through the file list.

- **Where the logs stop.** Run 1 emitted output for 107 of the repository's 218 test files and was cut right after `packages/cli/src/commands/__tests__/gc.test.ts`. Run 2 emitted output for only 63 files and was cut inside `packages/daemon/src/__tests__/heavy-job-native-lifecycle.test.ts`. Run 2 is a strict subset of run 1's coverage except for four files that run 1 never reached in that order (`create-daemon-running`, `full-workflow`, `ci-watch-scenario`, `daemon-restart-recovery`).
- **Never executed in either run** (no evidence at all, neither pass nor fail):
  - all of `packages/platform/src/ipc/__tests__` (`windows-ipc.test.ts`, `path-unusable.test.ts`) — so **9b has no direct unit evidence**, only daemon/testkit symptoms;
  - all of `packages/platform/src/trust/__tests__` (`windows.test.ts`, `windows-acl-batch.test.ts`, `windows-powershell.test.ts`, `posix.test.ts`) — so **9c has no direct unit evidence**, only the `logs.test.ts` runtime blow-up and one `anchor-log-trust` failure;
  - all of `packages/platform/src/service/__tests__` (`windows-service.test.ts`, …) — so **9i rests on a single CLI-level failure**;
  - all of `packages/platform/src/process/__tests__` (`windows-process.test.ts`, `start-time-formats.test.ts`, …) — 9d's platform-port layer is unproven;
  - all of `packages/platform/src/paths/__tests__` and `packages/platform/src/socket/__tests__` — 9h and the socket/pipe path limits are unproven;
  - every `packages/core/src/*/__tests__` directory except `packages/core/src/__tests__` — that is roughly 77 files including all of `core/src/state`, `core/src/resources`, `core/src/analysis`, `core/src/config`, `core/src/git`, `core/src/paths`. **9f and 9h are therefore measured only through CLI/daemon call sites**, never at the unit that actually implements them;
  - `packages/daemon/src/ci/__tests__` (3 files);
  - 11 of the 18 files in `packages/cli/src/commands/__tests__` (run 1 reached only `adapter`, `analyze`, `cleanup-estimates`, `completion`, `daemon`, `diagnostics`, `gc`), so `ci.test.ts`, `git-error.test.ts`, `init.test.ts`, `jobs.test.ts`, `production-init.test.ts`, `readiness.test.ts`, `remove*.test.ts`, `status*`, `trust*` are unmeasured;
  - 2 of 40 `packages/daemon/src/__tests__` files and 1 of 8 `packages/protocol/src/__tests__` files.
- **Consequence for planning.** The numbers in `todo.md` ("80 native fail") match run 1 exactly, but they describe only the first half of the suite. Any of the never-run files can add failures to any cluster; the per-unit lists below therefore include the relevant never-run platform/core files as well as the observed failures.

## Per-unit test lists

Each list is a `win32_test_filter` value: paste it straight into
`gh workflow run CI --ref <branch> -f win32_test_filter="…"`.
Files marked below as never-run in these logs are included because they are the unit's own code area and must be shown green before the cluster can be called closed.

### W2-1 (9a) — DaemonClient frame decoder
```
packages/cli/src/__tests__/client.test.ts packages/protocol/src/__tests__/ipc-framing.test.ts packages/protocol/src/__tests__/ipc.test.ts
```
(Both protocol files ran clean in run 1; they are here as regression cover for the decoder change.)

### W2-2 (9c) — ManagedLogStore ACL / powershell batching
```
packages/platform/src/trust/__tests__/windows.test.ts packages/platform/src/trust/__tests__/windows-acl-batch.test.ts packages/platform/src/trust/__tests__/windows-powershell.test.ts packages/platform/src/trust/__tests__/posix.test.ts packages/daemon/src/__tests__/logs.test.ts packages/daemon/src/__tests__/anchor-log-trust.test.ts packages/daemon/src/__tests__/main.test.ts packages/core/src/__tests__/file-trust-guard.test.ts
```

### W2-3 (9f) — SQLite/state path, disk and gc
```
packages/cli/src/commands/__tests__/gc.test.ts packages/cli/src/commands/__tests__/adapter.test.ts packages/cli/src/__tests__/daemon-status.test.ts packages/cli/src/__tests__/reconcile-fallback.test.ts packages/cli/src/__tests__/remove-runtime.test.ts packages/cli/src/__tests__/main.test.ts packages/daemon/src/__tests__/runtime-factory.test.ts packages/core/src/resources/__tests__/guard.test.ts packages/core/src/resources/__tests__/gc.test.ts packages/core/src/resources/__tests__/removal.test.ts packages/core/src/resources/__tests__/materializer.test.ts packages/core/src/resources/__tests__/guard-lifecycle.test.ts packages/core/src/resources/__tests__/gc-repository-lease.test.ts packages/core/src/resources/__tests__/preparation.test.ts
```
(Add `packages/core/src/state/__tests__/*.test.ts` once the guard failures clear; all 17 of those files are unmeasured on win32.)

### W3-1 (9b) — named pipe IPC server and client
```
packages/platform/src/ipc/__tests__/windows-ipc.test.ts packages/platform/src/ipc/__tests__/path-unusable.test.ts packages/platform/src/socket/__tests__/socket-path.test.ts packages/platform/src/socket/__tests__/policy.test.ts packages/platform/src/socket/__tests__/limit-measurement.test.ts packages/testkit/src/__tests__/ipc-address.test.ts packages/daemon/src/__tests__/runtime-factory.test.ts packages/daemon/src/__tests__/main.test.ts packages/cli/src/commands/__tests__/daemon.test.ts packages/cli/src/__tests__/create-daemon-running.test.ts packages/cli/src/__tests__/readiness-workflow.test.ts packages/cli/src/__tests__/full-workflow.test.ts
```

### W3-2 (9d) — supervisor and anchor
```
packages/daemon/src/__tests__/process-supervisor.test.ts packages/daemon/src/__tests__/process-anchor.test.ts packages/daemon/src/__tests__/anchor-deadline.test.ts packages/daemon/src/__tests__/completion-path-identity.test.ts packages/daemon/src/__tests__/daemon-restart-recovery.test.ts packages/testkit/src/__tests__/scenario-child.test.ts packages/platform/src/process/__tests__/windows-process.test.ts packages/platform/src/process/__tests__/start-time-formats.test.ts packages/platform/src/__tests__/job-scope.test.ts packages/platform/src/__tests__/select.test.ts
```

### W4-1 (9e) — heavy-job process tree cleanup
```
packages/daemon/src/__tests__/heavy-job-native-lifecycle.test.ts packages/daemon/src/__tests__/idle-daemon.test.ts packages/cli/src/__tests__/jobs-workflow.test.ts packages/daemon/src/__tests__/heavy-job-memory.test.ts packages/daemon/src/__tests__/heavy-job-logs.test.ts packages/daemon/src/__tests__/heavy-job-exit-evidence.test.ts packages/daemon/src/__tests__/heavy-job-finalization.test.ts packages/daemon/src/__tests__/heavy-job-completion-failure.test.ts packages/daemon/src/__tests__/heavy-job-historical-result.test.ts
```
(The five non-`native-lifecycle` heavy-job files passed in run 2 before the cut; they are included as regression cover.)

### W4-2 (9g) — CLI surface tests (`/bin/sh` dependency, `getuid` gap)
```
packages/cli/src/__tests__/worktree-reclaimable-mounts.test.ts packages/cli/src/__tests__/main.test.ts packages/cli/src/__tests__/refresh-remotes.test.ts packages/cli/src/__tests__/remove-runtime.test.ts packages/daemon/src/__tests__/ci-watch-scenario.test.ts packages/cli/src/commands/__tests__/cleanup-estimates.test.ts packages/cli/src/commands/__tests__/analyze.test.ts
```

### W4-3 (9i) — Scheduled Task lifecycle, PowerShell install/uninstall, completion, Git Bash
```
packages/platform/src/service/__tests__/windows-service.test.ts packages/platform/src/service/__tests__/darwin-service.test.ts packages/platform/src/service/__tests__/linux-service.test.ts packages/cli/src/commands/__tests__/daemon.test.ts packages/cli/src/commands/__tests__/completion.test.ts packages/cli/src/__tests__/completion-production.test.ts packages/cli/src/__tests__/daemon-lifecycle.test.ts packages/cli/src/__tests__/daemon-startup-diagnostic.test.ts
```

### W3-3 (9h) — Windows path canonicalization, drive letter/UNC, junctions and reparse points
```
packages/cli/src/__tests__/forget.test.ts packages/testkit/src/__tests__/isolated-home.test.ts packages/platform/src/paths/__tests__/platform-paths.test.ts packages/core/src/paths/__tests__/contains.test.ts packages/core/src/__tests__/platform-independence.test.ts packages/core/src/analysis/__tests__/symlink-policy.test.ts packages/core/src/analysis/__tests__/removal-lifecycle.test.ts packages/core/src/analysis/__tests__/worktree-reclaimable.test.ts packages/core/src/git/__tests__/worktree-parser.test.ts
```
(None of the `core/src/analysis` or `core/src/git` files produced any output on win32 in these runs, so their win32 state is entirely unknown.)
