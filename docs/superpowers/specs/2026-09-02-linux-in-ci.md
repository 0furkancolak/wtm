# Increment C2 — Linux in CI

## Status

Draft — 2026-09-02. Second half of Increment C in
`docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`. Follows C1
(`2026-09-01-platform-seam-design.md`, landed as `b5991c5`).

## The claim this increment makes

**WTM runs on Linux x64, and a CI job proves it.**

C1 deliberately made no such claim. It extracted the seam and wrote the Linux backend to
completion everywhere a decision could be reached without a Linux kernel — path policy, socket
policy, unit-file rendering, `/proc` parsing, the `systemctl --user` command set — all driven by
fixtures and injected runners. That produced a commit where the Linux half was *designed* but
never *executed*. C2 is the increment that executes it.

The distinction matters because the failure mode of this kind of work is a green suite that
proves the wrong thing. 1185 tests pass on macOS today. Adding an `ubuntu` runner that skips
whatever is inconvenient would produce a second green column and a false claim. The exit
criterion is therefore not "the ubuntu job passes" but "the ubuntu job runs the same gates as
the macOS job, and where it cannot, the spec says why in writing."

## What this increment does not claim

- **Not Linux arm64.** One architecture, x64, matching the program map's "Linux x64 CI green".
- **Not a Linux release.** Nothing is published. `release.yml`, the signing consensus rule, the
  release artifact names, and the Homebrew formula are Increment E's, and D9 below records the
  list E inherits.
- **Not Windows.** Increment D.
- **Not musl / Alpine.** `ubuntu-latest` is glibc. `better-sqlite3` ships a `linuxmusl-x64`
  prebuild, so musl is plausible later; it is unproven and unclaimed here.

## Findings that set the scope

Three independent surveys of the tree (build pipeline, test suite, runtime paths) were run
before this spec. Their load-bearing findings, each re-verified by hand:

### F1 — The process anchor is a hard blocker, not a degradation

`packages/daemon/src/process-anchor.ts` is a `String.raw` template compiled with
`Function('require', anchorSource)` and run in the spawned child. It contains two unbranched
BSD `ps` invocations:

- `:371` — `ps -ww -p <pid> -o pgid= -o state= -o lstart= -o comm= -o command=`, whose
  `lstart` output (`"Tue Sep  1 21:27:02 2026"`) becomes the anchor's self-reported
  `processStartTime` in its `READY` handshake.
- `:333` — `ps -axo pid= -o pgid= -o state=` for the group-drain poll.

The supervisor then compares that self-report against the **platform port's** reading:

```
process-supervisor.ts:406   if (!sameIdentity(identity, inspection.identity)) throw new Error('ANCHOR_IDENTITY_MISMATCH');
```

where `#inspectProcess` resolves to `selectPlatformRuntime().process` — on Linux, the `/proc`
reader, which returns `linuxStartTime(btime, ticks)` = `"1756800000:2778072"`.

These two strings can never be equal, and the repo already proves it:
`packages/platform/src/process/__tests__/start-time-formats.test.ts:66` asserts that no real
macOS `lstart` string can be read as a Linux one. That test was written in C1 to protect the
seam; it doubles as the proof that **every `wtm start` and `wtm restart` on Linux fails today**
with `ANCHOR_IDENTITY_MISMATCH` and rolls back.

This is the increment's largest item and everything downstream of managed processes — roughly
25 tests in `process-supervisor.test.ts` alone, plus `process-anchor.test.ts` and all four
`runtime-factory.test.ts` composition tests — is blocked on it.

### F2 — Fixtures that isolate by `HOME` do not isolate on Linux

On macOS, setting `HOME` fully determines where WTM writes: everything derives from
`~/Library`. On Linux it does not. `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME`
are read from the ambient environment (`platform-paths.ts:57-72`) and *override* the
`HOME`-derived defaults. A CI runner exports `XDG_RUNTIME_DIR`.

The consequence is worse than a wrong assertion. Two tests that each build their own temporary
`HOME` would both resolve the daemon socket to the runner's real `/run/user/<uid>/wtm/wtmd.sock`
and contend for one address. `bun run test` runs with `--max-concurrency=1 --parallel=1`, which
makes this survivable but not correct, and it silently un-isolates every scenario child that
inherits `process.env` (`cli/src/commands/daemon.ts:271` passes `env: process.env` directly).

This is a property of the fixture contract, not of any one test: **on Linux, isolating a test
by `HOME` alone is not isolation.**

### F3 — Twelve test sites measure the host and hardcode macOS's answer

The socket path limit is 104 bytes on macOS and 108 on Linux. C1 moved every *product* call
site behind the seam — `grep darwinSocketPathLimitBytes packages/cli packages/daemon` is empty,
which was C1's own stated Wave-3 checklist item and is satisfied. But the *tests* still build
their fixtures from `darwinSocketPathLimitBytes` while exercising the host, so a 105-byte path
that macOS refuses is one Linux accepts:

`daemon/src/__tests__/socket-path-limit.test.ts:64,113` ·
`cli/src/__tests__/socket-path.test.ts:109,113,122,154` ·
`cli/src/commands/__tests__/daemon.test.ts:103,487,586,455` ·
`cli/src/__tests__/state-diagnostics.test.ts:259,267,275`

Four of these fail by asserting a macOS path (`Library/Application Support/...`,
`Library/Logs/...`); the rest fail by asserting `104`, or by expecting a refusal that does not
come.

### F4 — Two survey findings were overstated; recording the corrections

The surveys are cited above because they were right about F1–F3. They were wrong twice, and
scoping on an uncorrected survey is how an increment acquires work it does not need:

- **The `LAUNCHD_*` wording does not reach Linux users.** The survey reported ~40 sites in
  `service-lifecycle.ts` saying "launchd plist" as a user-facing contract defect. Verified:
  `cli/src/commands/daemon.ts:397-422` (`serviceManagerError`) rebuilds the message from the
  error *code* and is already templated over `managerName` — a Linux user reads "The systemd
  user domain is unavailable." The only thing copied from the original error is
  `safeContext()`, which filters to scalar `context` entries and never includes `message`.
  C1's D12 ruling therefore stands unchanged, and no wording work is in scope.
- **`better-sqlite3` needs no build on Linux.** The survey flagged the absent
  `trustedDependencies` as a risk that bun would skip the postinstall gyp build. Verified:
  `node_modules/better-sqlite3/prebuilds/` ships `linux-x64.node` alongside the darwin ones.
  There is no native build step to arrange, and the absent `trustedDependencies` — pinned by
  `scripts/__tests__/package-contents.test.ts:31` — stays absent.

### F5 — The watcher's re-arm loop is bounded but silent

`watcher.ts:205` closes a failing root and schedules a `watch-error` signal; `main.ts:328`
turns that into `#replaceWatcher()`. The survey called this an unbacked-off spin. It is not — but
this paragraph originally said "about 1 Hz", and that was **wrong by a factor of five**.

> **Corrected 2026-09-02 by C2-5, measured against a watcher rigged to fail on arming.** The
> interval is a flat 201-202 ms: ~5 Hz. `maxCoalesceMs` is a cap on how long the queue *delays* a
> batch, so it can only ever shorten a wait, never lengthen a period; the floor is the 200 ms
> debounce plus the rebuild's own duration. The conclusion — bounded, not a spin — survives. The
> number does not, and the error made the case for backoff look weaker than it is: each retry
> rebuilds every watch and fingerprints every root, five times a second, for a condition only a
> human can clear.

The real defect is that it is **anonymous**. On Linux the
plausible cause is inotify watch exhaustion (`ENOSPC` from `fs.inotify.max_user_watches`), and
the user sees a repeating error with no name for the condition and no remediation — the exact
failure shape items 39 and 41 were written to eliminate elsewhere in the product.

### F6 — Two tests passed only because the developer had a daemon running

Found while integrating the wave, not by a survey, and it is the sharpest thing in this document
about what "green" was worth before this increment.

`packages/cli/src/__tests__/main.test.ts` ("routes resolve, analyze, and remove…") and
`packages/cli/src/__tests__/refresh-remotes.test.ts` ("documents that the flag reaches the
network…") both reached the **developer's real** `~/Library/Application Support/WTM/wtmd.sock`.
Neither sets a home, and neither is about the daemon: one asserts that three argv shapes reach
three parsers, the other asserts help text. They passed through the whole of C1 — including its
final 1185-test verification — on a machine that had a daemon up, and turned red on the identical
commit once it stopped. Every CI runner is the second case, on either platform.

The `refresh-remotes` half was a **product** behaviour, not a test artifact: `wtm remove --help`
constructed a daemon client and dialled it in order to print static text, then discarded the
failure. Nothing downstream of `--help` can reach the daemon, so the connection had no reader even
when it succeeded. `isRuntimeInvocation` now excludes help invocations, pinned by a test that
counts connections arriving at a **real listening socket** — asserted that way because a client
which dials a dead address and swallows the error is indistinguishable from one that never
dialled, which is exactly how this survived.

The general lesson is F2's, arriving from a different direction: a test that does not say where
its state lives is not isolated, it is merely lucky, and the luck is host-shaped.

### F7 — The composition root threaded the port but not the platform

`packages/daemon/src/runtime-factory.ts:157` builds its `ManagedProcessSupervisor` with
`platformRuntime.process.*` for both readers and — before this increment — no `platform`. The
comment directly above it says a supervisor inspecting processes through a platform other than the
one the daemon was built for "is the exact class of drift the seam exists to remove", and then the
call omitted the field that decides it.

It was invisible because of *which* field was missing. The readers are what a test observes; the
platform is what the spawned anchor is told (D1). An injected runtime for the other platform —
which `runtime-factory.test.ts` already constructs — would have produced an anchor reporting its
identity in the host's dialect and a port reading it in the injected one, and the two cannot
compare equal. It surfaces as `ANCHOR_IDENTITY_MISMATCH`: a message blaming the process for
changing identity when in fact nobody ever asked it the same question twice.

This was a gap in the plan, not in the work — no task owned that file. Recording it because it is
the second increment running where a task's report caught something the lead's decomposition
missed, and the pattern is the same both times: the file that *wires* two things together belongs
to whichever task owns the contract, not to whichever task owns one end of it.

### F8 — `limits.ts` misstates Bun's own socket limit

`limits.ts:22` records that Bun's Unix socket limit "sits at 118 bytes". C2-7 measured it on this
machine under Bun 1.3.14 / macOS 15: it binds up to **122** bytes and refuses from 123.

The number governs nothing — it is background explaining why the daemon's preflight cannot be a
rescued `EINVAL` — and that argument holds at 118 or 122. It is recorded because the file's whole
method is to say where each number came from, and a sentence in it that nobody measured is the
thing that method exists to prevent. It also changed a real decision: the measurement child sweeps
to 128 bytes rather than 112 or 120, so that a boundary always falls inside the range and a child
accidentally run under Bun could never report "nothing in this range was refused".


## Decisions

### D1 — The anchor is told its platform; it does not observe it

`WTM_ANCHOR_SPEC` already exists: `process-supervisor.ts:873-879` builds it and the anchor
parses it at `:23`. It gains a `platform` field.

The anchor must **not** read `process.platform`. The identity dialect it reports is not a
property of the machine, it is a property of *the decision the supervisor already made*. The
supervisor accepts an injected platform; if the anchor observed its own, the two could disagree
and the disagreement would surface as `ANCHOR_IDENTITY_MISMATCH` — a message that would blame
the process for changing identity when in fact the two sides were speaking different dialects.
Telling it is the only construction in which that cannot happen.

### D2 — The anchor inlines both readers, and a live test forbids drift

The anchor is a string compiled with only `require` in scope. It cannot import
`@wtm/platform`, so the Linux reader is inlined and duplicates `platform/src/process/linux.ts`.
Duplication is a real cost and the mitigation must be a test, not a comment.

`process-supervisor.test.ts:251` already has the right shape for macOS — *"agree with
@wtm/platform about the running process"* — comparing a live reading against the port. C2
extends that block to run on whichever platform the test is executing on, so the CI job itself
is what forbids the two implementations from drifting. Without this, D2 is a silent
time-bomb; with it, drift is a red build.

### D3 — A test asserts platform behaviour by injection, or host behaviour by derivation; never by hardcoding

The rule that resolves every F3 site, stated once:

- A test **about a platform** injects that platform and asserts its constants. These stay
  written in terms of `darwinSocketPathLimitBytes` and `Library/Application Support` and are
  correct on any host. `platform/src/socket/__tests__/*` are already exactly this and need no
  change.
- A test **about the host** derives its fixture from the host's own policy —
  `selectPlatformRuntime().socket.limitBytes`, `.paths.socketRoot` — and asserts the
  relationship, not the number. "One byte past the limit is refused" is the claim; `105` is an
  accident of macOS.

No third category is permitted. A test that exercises the host while hardcoding a platform's
constant is the defect F3 describes, and it is invisible until the other platform runs.

### D4 — Fixture isolation on Linux means XDG, not just `HOME`

Every fixture that establishes an isolated `HOME` must also establish `XDG_RUNTIME_DIR`,
`XDG_STATE_HOME` and `XDG_CONFIG_HOME` beneath it, and every scenario child that inherits
`process.env` must receive them. This is not a Linux-specific patch applied to Linux-specific
tests: it is a correction to the fixture contract, applied on both platforms, where it is inert
on macOS and load-bearing on Linux. Encoding it in the shared fixture rather than at call sites
is what stops the next test from reintroducing F2.

### D5 — 108 is measured in CI, not cited

`platform/src/socket/limits.ts:27-41` says so itself: 104 was measured against macOS 15 / Node
24 by binding paths from 96 to 112 bytes; **108 was never measured** — it is a citation of
`linux/un.h`. C1 could not do better without a kernel. C2 can, and a constant that governs
whether the daemon can bind at all should not remain a citation once a machine exists that can
answer. The measurement runs as a test, so a kernel or libc change that moves the boundary is
caught rather than assumed.

### D6 — A `/proc` entry that cannot be read is not a group member

`platform/src/process/linux.ts:148` continues past `ENOENT` — a process exiting mid-walk is
normal — but converts every other errno into `status: 'failed'` for the whole scan. `EACCES`/
`EPERM` on another user's entry is equally normal wherever `/proc` is restricted, and one such
entry would make every group inspection fail.

> **Corrected 2026-09-02 by C2-4: this paragraph originally overstated its own case.** It said
> "in a container, or on a shared host". That is wrong. On a stock Linux `/proc`, `/proc/<pid>` is
> `dr-xr-xr-x` and `stat` is world-readable — including inside an ordinary Docker or Podman
> container, which namespaces `/proc` without restricting it. The reachable conditions are a
> `hidepid=1` mount, systemd's `ProtectProc=` (v247+, implemented as a hidepid view), and
> SELinux/AppArmor or sandboxed-`/proc` denials. `hidepid=2` hides the directories from `readdir`
> entirely, so it surfaces as `ENOENT` and was already handled.
>
> The fix stands — it is cheap, and the failure it removes is a leaked process tree — but it is a
> robustness fix for hardened hosts, not the everyday correction the original wording implied. It
> is forward-looking in one concrete way: WTM's own rendered systemd unit sets no `ProtectProc=`
> today, so a future hardened unit would make this reachable for the daemon itself. A failed inspection
stops the supervisor from killing a group it should kill, so the blast radius is a leaked
process tree, not a wrong number.

macOS already has the correct semantics for free: `ps` simply omits rows it may not see. Linux
should match — treat an unreadable entry as "not mine". This is decidable without a kernel and
is fixed here rather than deferred, because the increment that first runs on Linux is the one
that owns it.

### D7 — Watch failure gets a name and a remediation; recursive watching is decided by the run

Two halves, split by what is decidable now.

**Decidable now:** the anonymous retry (F5) gets a coded, user-visible diagnostic naming
inotify exhaustion and the `fs.inotify.max_user_watches` remedy, with backoff so a permanent
failure does not log at 1 Hz forever. This follows the rule cross-cutting every increment: a
new user-visible failure carries a stable code registered in the protocol catalogue and
documented in `docs/18-errors-json-contract.md`.

**Not decidable now:** whether Node 24's `recursive: true` on Linux delivers events for
directories created *after* the watch was opened, within the 5 s budget
`daemon/src/__tests__/main.scenario.ts:433-475` allows. The watcher requires `recursive: true`
at the type level (`watcher.ts:36-40`) with no fallback path. This spec deliberately does not
pre-commit to a design. If the run is green, nothing is built. If it is red or flaky, the
finding is written up and a fallback is scoped then — designing a per-directory walk against a
guess would be building for a failure that may not exist.

### D8 — The Linux SEA build is in scope; Linux *publishing* is not

`binary:verify` (`build:binary` + `sea-smoke`) is the strongest end-to-end evidence the repo
has: it runs the real CLI as a standalone executable against a real git repository. Omitting it
from the Linux job would make "CI green" mean materially less on Linux than on macOS, which is
exactly the asymmetry the opening section rejects.

The work is small and entirely in `scripts/build-sea.ts`, which today has an `arch` field and
no platform field at all:

- `:70`, `:84`, `:85` — `codesign` becomes a **no-op on Linux, not a substitution.** There is
  nothing to remove (an ELF Node carries no embedded signature) and nothing an unsigned-but-
  attested Linux binary gains by pretending otherwise.
- `:68` — `/usr/bin/strip -x -S` is kept: `-x` and `-S` are GNU binutils flags with the same
  meaning, and `/usr/bin/strip` is the correct path on Ubuntu. The *comment* justifying
  strip-before-unsign is Mach-O `__LINKEDIT` reasoning and must be marked as darwin-only, since
  the ordering it argues for has no meaning for ELF.
- `:78-79` — `--macho-segment-name` is dropped on Linux. Verified it would be *accepted and
  ignored* (`postject/dist/cli.js:62-65` declares it unconditionally), so this is for honesty,
  not correctness; the resource name `NODE_SEA_BLOB` is already the ELF section name.
- `:181` — the output line hardcodes `darwin-${arch}` and must name the real platform.

`scripts/__tests__/sea-smoke.test.ts:122` asserts the darwin state path and moves to the
selected platform's, per D3.

### D9 — What Increment E inherits, written down

C2 stops at `binary:verify`. It does not touch publication. E inherits this list, which is the
survey's finding and is recorded here so E does not have to rediscover it — the artifact set is
written down in six places that must change together:

| site | what it hardcodes |
|---|---|
| `scripts/verify-release.ts:7` | the closed set `wtm-darwin-{arm64,x64}.tar.gz`; a Linux entry is rejected as *unexpected* |
| `scripts/verify-release.ts:16` | `releaseArchiveFor(arch)` derives the name from arch alone |
| `scripts/release-artifacts.ts:36,56` | archive and checksum named `wtm-darwin-${arch}` regardless of platform |
| `scripts/render-homebrew-formula.ts:6-9` | both darwin digests required |
| `.github/workflows/release.yml:186-188` | `gh release create` lists the two archives explicitly |
| `.github/workflows/release.yml:106,134,232` | uploads as `wtm-darwin-*` and globs for it — **the one that fails silently**, dropping a Linux artifact into a green publish |

Two rules in that pipeline are not renames and need an actual decision from E:

- `verify-release.ts:171-173` refuses a stable release whose executable is not `signed`. A
  Linux binary can only ever be `unsigned`. The rule has to become "signed where signing
  exists", or Linux cannot ship stable.
- `release.yml:146-148` requires every job to report the *same* signing status. A Linux job
  reporting `unsigned` beside a signed macOS job fails the publish outright.

Also inherited: `release-artifacts.ts:70-73` matches `Mach-O` and the spellings `arm64`/
`x86_64`, where Linux `file` says `ELF` and `x86-64`; and `performance.yml:40` names its
artifact by arch alone, so adding an ubuntu leg there is a duplicate-name failure under
`upload-artifact@v4`.

**Added 2026-09-02 by C2-6 — two omissions in the table above.** First, every production site has
a change-detector test hardcoding the same closed darwin set, and each will go red in E's commit:
`scripts/__tests__/verify-release.test.ts:15-16,122-129,151-208`,
`release-artifacts.test.ts:55,91-92,96,106`, `render-homebrew-formula.test.ts:70-71,145,160-161`,
and `package-contents.test.ts:18`. Second, `release-artifacts.ts:70-73` is not a rename job: `:79`
builds its host with `arch: process.arch` and **no platform field**, and `machoArchitectures` at
`:68` is keyed by arch alone. It is the same threading C2-6 did in `build-sea.ts`, and
`SeaBuildResult` now carries `platform` so E can read it rather than re-derive it.

Related, and nobody's yet: **nothing type-checks `scripts/`.** `bun run typecheck` runs the seven
`packages/*` projects only, so `build-sea.ts`'s new `platform: PlatformId` field is enforced only
when its tests run. Adding `scripts/` to the gate is not free — there is a pre-existing error at
`build-sea.test.ts:71` — so it is recorded rather than done in passing.

### D10 — The `os` field changes last, and a test pins it

`package.json` declares `"os": ["darwin"]`. C1 left it deliberately (its D11): a manifest field
is a promise, and C1 had no evidence for a Linux promise. C2 changes it to
`["darwin", "linux"]` — and does so **after** the ubuntu job is green, as the last edit of the
increment, because until then the promise is still unfunded.

`npm pack` does not enforce `os`, so nothing currently fails when the field is wrong; the
consequence is `EBADPLATFORM` for an end user and silence in CI. `package-contents.test.ts`
gains an assertion pinning the field to the platforms CI actually runs, which is what converts
a promise into something the build can check. The `description` and the `macos`/`launchd`
keywords are updated in the same edit.

### D11 — `plistPath` stays; the deprecation is scheduled, not executed

C1's D13 kept `plistPath` as a macOS-only alias for `definitionPath` so the JSON change was
additive, and recorded that this leaves one of item 9's criteria unmet.

C2 does not remove it. `definitionPath` is already present on every platform, which is the
property a cross-platform consumer needs; `plistPath` is an *additional* macOS field that no
portable consumer reads. Removing it now breaks `0.1.0-rc.1` consumers and buys nothing this
increment needs. It is scheduled for the first increment that has an independent reason to
break the daemon JSON contract, and `docs/04-cli-reference.md` says so.

### D12 — `launchd.ts` and `launchd.test.ts` survive this increment

The `launchd.ts` facade is confirmed dead product code — `cli/src/main.ts:337` builds from
`hostPlatformRuntime().service`, and the only remaining caller is `launchd.test.ts`. Deleting
both is 2500 lines of cleanup that is sitting there asking to be done.

It is not done here. `launchd.test.ts` went through C1's 2580-line refactor byte-unchanged and
is the strongest evidence the repo has that the service publisher still behaves exactly as it
did before the seam existed. The increment that first runs a second platform is precisely the
increment in which that macOS regression evidence is worth most. Deleting it in the same commit
that introduces Linux would trade the best available proof for a smaller diff. It goes after
Linux CI has been green through at least one release.

### D13 — The CI job runs the macOS gates, and names what it cannot

The ubuntu job runs `lint`, `typecheck`, `test`, `test:e2e`, `build`, `package:verify`,
`binary:verify` — the same list as the macOS legs, in the same order.

The job matrix keys on platform *and* arch. The existing legs are named `Validate ${arch}`,
so an ubuntu x64 leg would collide with `macos-15-intel` in the job name; the name becomes
platform-qualified.

Node is pinned to 24.18.0 via `actions/setup-node` exactly as the macOS legs do — not because
the SEA build is the only consumer, but because `engines.node` is `>=24.0.0`,
`assertSupportedRuntime` enforces it, and the Ubuntu image's default `node` is not 24. Omitting
it turns roughly twenty scenario children red for a reason that has nothing to do with Linux.

### D14 — The first red run is evidence, and it is written down

C1 was specified before it was run and its spec was wrong four times; each error was found by
implementation and corrected in the spec rather than worked around. C2 is different in kind: it
is specified against a machine nobody here has run. The probability that this document is
complete is low.

The rule is therefore stated in advance. Whatever the first ubuntu run finds that is not
predicted above is added to this spec as a numbered finding with its evidence, before it is
fixed. A defect fixed without being written down leaves the next increment believing this
spec was right.

## Acceptance criteria

1. An `ubuntu-latest` x64 job in `.github/workflows/ci.yml` runs `lint`, `typecheck`, `test`,
   `test:e2e`, `build`, `package:verify` and `binary:verify`, and is green.
2. The macOS legs stay green with no behaviour change; no test is skipped, weakened, or made
   platform-conditional to achieve criterion 1.
3. `wtm start` launches, supervises and stops a managed task on Linux — the anchor and the
   platform port agree on process identity, proven by a live test running on the CI kernel.
4. No test asserts a platform constant while exercising the host (D3), and none isolates by
   `HOME` alone (D4).
5. `linuxSocketPathLimitBytes` is backed by a measurement that runs on Linux (D5).
6. An inotify watch failure produces a coded, documented, user-visible diagnostic naming the
   remedy (D7).
7. `bun run binary:verify` produces a working Linux executable and `sea-smoke` passes against
   it (D8).
8. `package.json` declares `["darwin", "linux"]`, pinned by a test (D10).
9. `todo.md` item 9's Linux checklist reflects what CI now proves, and no more.

## Open questions only a kernel answers

Carried in deliberately unresolved, per D7 and D14:

- Does Node 24 recursive watching on Linux deliver events for directories created after the
  watch opened, inside the scenario's 5 s budget?
- Is `linuxSocketPathLimitBytes = 108` correct on the CI kernel, or does the bindable maximum
  differ from the `linux/un.h` citation?
- Does `systemctl --user` exist and answer on `ubuntu-latest`, and is `/usr/bin/systemctl` the
  right path? C1 assumed both. If a GitHub runner has no user session bus, the systemd
  lifecycle cannot be integration-tested there and this spec gains a written limitation rather
  than a skipped test.
- Does systemd on the runner satisfy the `>= 240` assumption C1 made for `Type=exec` and
  `append:`?
