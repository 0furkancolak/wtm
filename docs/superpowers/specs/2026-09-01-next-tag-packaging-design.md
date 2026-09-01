# Increment B — Next-tag packaging and first-run correctness

## Status

Draft — 2026-09-01. Program map: `docs/superpowers/specs/2026-08-31-v1-stable-program-map.md`.
Covers `todo.md` items 36, 37, 39, 40, 41 and the "Distribution / install" testing checklist.

## Why these five are one increment

They are not one subsystem. They are one *user*: the person who downloaded the `v0.1.0-rc.1`
archive, ran it under an isolated `HOME`, and wrote down every wall they hit. Increment A made the
architecture correct; every item here is a wall in the product's first five minutes, and the P0-B
group is the only P0 layer still at zero.

The grouping is defensible on ordering grounds too: none of these touch a subsystem that
Increments C–E rewrite. 36 and 37 are documentation and one error message. 39 and 40 are macOS
runtime paths that Increment C's platform abstraction will *move* but not redesign — and doing them
now means the platform layer is extracted from code that is already correct rather than from code
that still has these defects baked in.

## What the field report actually found, restated precisely

The todo records symptoms. The surveys found causes, and three of them are different from what the
symptom suggests. Those differences change the work.

### 36 — Gatekeeper kills the browser-downloaded binary

Cause is settled and not fixable in code. macOS sends `SIGKILL` at `exec` time when a quarantined
binary carries no usable signature, so **no code inside the executable ever runs**. There is no
message WTM can print, no exit path it can take, and no diagnostic it can offer about itself. The
todo lists "investigate whether a comprehensible error is possible instead of the silent SIGKILL"
as an open question; the answer is no, and this spec records it as answered so nobody investigates
it twice.

What is left is documentation, and one real engineering problem inside it: a workaround that
outlives the defect is worse than no workaround, because `xattr -d com.apple.quarantine` is advice
to strip a security attribute. Increment G (notarization) must be able to delete this passage
completely and *know* it deleted all of it.

Survey finding that shapes the work: `Gatekeeper`, `quarantine`, `xattr` and `spctl` appear **zero
times** in `README.md`, `CHANGELOG.md`, and `docs/`. And `.github/workflows/release.yml:184`
publishes the GitHub Release body with `--notes-file CHANGELOG.md`, so the changelog *is* the
release notes — the todo's two separate sub-items ("README install section" and "prerelease notes")
are two renderings of one source, not two documents to keep in sync.

### 37 — the quick start does not work

The todo proposes renaming `dev` to `make:dev`. That does not fix it. `make:dev` exists only when
the workspace happens to contain a `Makefile` with a `dev` target (`packages/adapters/src/make.ts:54`
is the only producer of the `make:` namespace), so on a clean workspace the renamed command fails
exactly as the original did. The quick start at `README.md:127-137` runs `wtm resolve dev` before
`README.md:178` has told the reader that tasks must be defined — the ordering is the defect, not the
name.

Compounding it: there is **no command that lists tasks**. The CLI registers 20 commands
(`packages/cli/src/main.ts:161-486`) and none of them enumerates what `resolve`/`start` would accept.
So a user who hits `Unknown task: dev` has no way to discover the right name. That is why listing
known tasks *in the error* is load-bearing here and not a nicety: the error message is the only
surface where that information can reach the user.

The throw site already has what it needs. `resolveTask`
(`packages/core/src/runtime/task-resolver.ts:37-42`) holds the validated `config` and therefore
`config.tasks` when it decides the task is unknown, and discards it.

### 39 — raw stack trace, leaked build paths, no length check

Three separable defects reported as one.

**(a) The length limit is real and unguarded.** No constant, helper, or validation for the macOS
`sun_path` limit exists anywhere in the tree. The single acknowledgement is a comment in a test
(`scripts/__tests__/sea-smoke.test.ts:29`).

**(b) The bound path is not the advertised path — but it is not longer, and this spec was wrong to
say it was.** `UnixIpcServer` binds `privateSocketPath(...)` (`packages/daemon/src/server.ts:184`)
and links the published name afterwards (`:202`). This document originally claimed that helper
dot-*prefixes* the basename, making the bound path one byte longer, and specified a preflight around
that one-byte band. **It does not.** It *substitutes* the first character — `wtmd.sock` becomes
`.tmd.sock`, the same nine bytes — which is what the `candidate !== '.' && candidate !== '..'` guard
beside it exists to protect. Corrected by measurement during implementation, per the house rule that
where design and code disagree the code wins.

So `bound <= published` always: equal for an ASCII basename, and one byte *shorter* when the first
character is multi-byte. The constraining address is the published path, and a check measured against
it is not off by one.

The derivation was deliberately left alone — equal-length substitution is the safer property to keep.
But the preflight measures the **maximum** of both addresses rather than assuming which is longer, so
a later change back to prefixing cannot silently reopen a gap, and a test pins that the measurement
never follows a shorter bound path down.

**(c) The path is defined three times and shared nowhere:** `packages/cli/src/main.ts:1187`,
`packages/daemon/src/runtime-factory.ts:61`, and a second literal at `:73`. A check attached to one
is a check the other two do not get.

**The stack leak has one address.** `packages/cli/src/commands/daemon.ts:159` reads
`error.stack ?? error.message` and writes it to stderr — the only `.stack` read in non-test source.
The envelope printed beside it is already clean and deliberately cause-free
(`packages/cli/src/commands/daemon.ts:185-207`); the leak is a *second*, parallel write. Separately,
`packages/cli/src/bin.ts:9` has no catch-all, so anything escaping `runCli` becomes an unhandled
rejection and Node prints the full trace. `packages/cli/src/sea-bin.ts:28-34` already does the right
thing — message only, no stack — so the correct behaviour exists in the repo and needs copying, not
inventing.

Why the build paths appear at all: `scripts/build-sea.ts:44-55` writes the absolute build-machine
bundle path into `sea-config.json` as `main`, and `Bun.build` is called at `:129-135` with no
sourcemap, so every SEA stack frame names `/Users/runner/work/...`. This spec does **not** propose
changing the build to hide them. Stack frames naming the build host are normal; printing them at a
user is the defect. Fix the printing.

### 40 — `daemon status` reports another `HOME`'s agent

The todo offers two options: derive the label per `HOME`, **or** compare the loaded agent's program
path and report a mismatch. The second cannot work, for two independent reasons.

First, mechanically: the only launchctl output parsed today is a single `state = ` regex
(`packages/daemon/src/launchd.ts:2236`), and retained command output is truncated to 4 KiB by
`sanitizeCommandOutput` (`:2257-2262`) while the child is allowed 8 MiB (`:25`). A service `print`
report can push the `program`/`arguments` block past the retention limit, so the comparison would
sometimes have nothing to compare.

Second, and decisively: a launchctl service name is `gui/<uid>/<label>`
(`packages/daemon/src/launchd.ts:197`). Two `HOME`s under one uid sharing a constant label do not
merely *report* each other — they cannot both be bootstrapped. Detection would leave the second
`HOME` accurately diagnosed and still unable to install. Only a derived label makes the second
installation possible at all.

**Decision: derive the label from the resolved `HOME`.** The plumbing is one line from existing —
`launchdCommands` already receives `plistPath` (`:193-206`) and simply does not use it for the
service name.

Three consequences that make this more than a constant change:

1. `LaunchdLifecycleResult.label` is typed `typeof launchdLabel` (`:121`) — pinned to the string
   literal. A computed label forces it to `string`, rippling through
   `packages/daemon/src/index.ts:96` and every consumer.
2. **A label change silently breaks crash recovery.** `validateJournal` (`:1834-1840`) rebuilds the
   expected `.tmp-<txid>` / `.replaced-<txid>` / `.removed-<txid>` sibling filenames *from the
   label* and rejects anything else as an unsafe path. Every in-flight journal and every
   `.<label>.operation-lock` (`:508-509`) written under the old label becomes unreachable the
   instant the label changes. Migration must sweep them, not only adopt the plist.
3. Nothing in the file distinguishes a plist WTM wrote from one it did not. `readSafeManagedFile`
   (`:969-989`) checks containment, ownership, mode and link count — never authorship — and
   `install` already takes over any pre-existing plist at that path (`:342-396`). So "adopt the old
   agent" is largely the *existing* file behaviour; what is missing is booting out the old
   **service** under the old label before publishing under the new one.

`docs/05-daemon-and-macos-runtime.md:30` already reserves the right to change the label before
public release, so this breaks no published promise. `docs/04-cli-reference.md:385-403` documents
the daemon commands but never documents `status`'s output fields — the very fields whose mutual
contradiction is this defect.

### 41 — a worktree created after `init` is invisible

The largest gap between symptom and cause. The reported `[GIT_REPOSITORY_DEGRADED]` from `wtm env`
is **not** a missing feature. `findRegistration` (`packages/daemon/src/task-resolution.ts:191-210`)
already throws `DaemonRegistrationError`, which already carries
`code: 'WTM_WORKSPACE_NOT_FOUND'` (`packages/daemon/src/runtime-controller.ts:31`) and already
carries the correct, actionable message: *"This directory is not inside a worktree WTM has
registered. Run `wtm init` in the workspace root."*

Both are then thrown away. `toDiagnosticError` (`packages/cli/src/diagnostics.ts:437-466`) recognises
an error only if it is registered in the `diagnosticSourceItems` WeakMap (`:112`), which only
`DiagnosticSourceError` populates. `DaemonRegistrationError` is not in it, so it falls through to
`:445-455` and is relabelled `GIT_REPOSITORY_DEGRADED` with the message *"Diagnostic data source
failed."* The user loses the real code, the real message, and the right exit code —
`WTM_WORKSPACE_NOT_FOUND` maps to 2, `GIT_REPOSITORY_DEGRADED` falls to the default 1
(`packages/cli/src/main.ts:1207-1226`).

So the first half of item 41 is not "add a diagnosis". It is "stop discarding the diagnosis that is
already there".

The second half — automatic reconciliation — also already half exists, in two precedents this spec
adopts rather than reinvents:

- `packages/cli/src/removal-coordinator.ts:208-240` falls back to an **in-process local reconcile**
  when the daemon is unreachable, then warns with `WTM_DAEMON_UNAVAILABLE` and says the registration
  was reconciled locally. That is exactly the shape item 41 needs.
- `packages/cli/src/main.ts:975-981` already degrades `resolve`/`run` to `unregisteredTaskResolution`
  on a `DaemonRegistrationError`.

And the daemon already reconciles every registered repository at startup
(`packages/daemon/src/main.ts:198`). The plan required this be tested before any code was written for
it. **Settled during implementation: it holds.** The test was green on an unchanged tree, with the
watcher stubbed out so the startup pass was the only thing that could explain the result, and no
production code was written for that limb. Acceptance criterion 11's second half is closed by
evidence rather than by code, and the test is labelled a characterization test.

Only the other limb needed building: a local reconcile for when the daemon never returns.

Two divergent cwd→worktree lookups exist and explain why `status` and `env` disagree: the throwing
one at `packages/daemon/src/task-resolution.ts:191`, and a non-throwing one returning `undefined` at
`packages/cli/src/state-diagnostics.ts:58-60` (whose comment at `:45-57` already describes this exact
bug class). This spec does not merge them — `status` answering with nulls is correct behaviour for a
read command — but it does require that they agree on *whether* the worktree is registered.

## Cross-cutting hazard: the third copy of the error catalogue

`packages/cli/src/commands/git-error.ts:75-111` hand-enumerates all 36 error codes in a
`knownCodes` set. Nothing holds it to `wtmErrorCodeSchema`. Increment A fixed the four codes that had
already drifted, but not the mechanism — a code absent from that set is silently remapped to
`GIT_REPOSITORY_DEGRADED` (`:40-45`) and loses its exit code.

**This increment adds new codes, so it walks straight into that trap.** The set is therefore derived
from the schema before any new code is introduced, which retires the failure class rather than its
current instance. This is a prerequisite task, not a cleanup.

## Design decisions

### D1 — One socket-path module, and the check measures the bound path

A single exported definition owns: the published path, the derivation of the private bind path, the
platform limit, and the preflight. The CLI and both `runtime-factory` literals consume it. The
preflight measures `Buffer.byteLength` (not `.length` — the limit is bytes and `HOME` may hold
non-ASCII) of the longest path that reaches `bind()`.

Measured during implementation, not assumed: on macOS 15 with Node 24 the limit is 104 bytes — 104
binds, 105 raises `EINVAL` — and `connect()` breaks at the same byte. **Bun's limit is 118.** So the
development runner binds paths the shipped Node SEA cannot, and this defect does not reproduce under
`bun test` at all. That is the reason the preflight is an explicit measurement rather than a rescued
`EINVAL`: the failure being rescued cannot be provoked in the environment the code is written in.

The failure is a new code, `WTM_SOCKET_PATH_TOO_LONG`, reported with the measured length, the limit,
and the offending path. It is registered in `packages/protocol/src/errors.ts`, documented in
`docs/18-errors-json-contract.md` (the parity test at
`packages/protocol/src/__tests__/errors.test.ts:65-74` enforces this), and given an exit code in
`exitCodeForError`. Class: configuration the user must change ⇒ exit 2.

Remediation uses the existing `command-suggestion` mechanism
(`packages/cli/src/diagnostics.ts:592-605`).

Answered during implementation: the quarantine sibling path
(`packages/daemon/src/server.ts:761-763`) is **never address-bearing**. It reaches only `rename`,
`lstat`, `link` and `unlink`, at every call site; the only two paths that reach an address are the
published path and the bound one. Confirmed by measurement as well as by reading — a socket bound at
81 bytes was renamed to a 149-byte path, stayed a socket, linked back, and kept serving. It does not
enter the limit, and the threshold is unchanged.

### D2 — `doctor` gains its first host-scoped checks

`doctor`'s `check` field is a closed enum (`packages/cli/src/diagnostics.ts:65`) and every existing
check is workspace-scoped, taking a `RegisteredWorkspace`. Both 39 and 41 add checks, and the
socket-path check is host-scoped — the first of its kind.

Adding a check requires editing three places in lockstep: the enum (`:65`), `doctorOrder`
(`:152-154`), and `unknownDoctorFindings` (`:155-162`). The increment adds two: `socket-path`
(host-scoped) and `registration` (workspace-scoped).

`registration` also removes an existing misfiling: the "not inside a worktree WTM has registered"
message currently surfaces as an **adapters** finding of status `unknown`
(`packages/cli/src/state-diagnostics.ts:196-201`), which is where a reader would never look for it.

The two states the todo requires be distinguishable — "daemon unreachable" and "worktree not
registered" — are independently expressible today (`WTM_DAEMON_UNAVAILABLE`,
`WTM_WORKSPACE_NOT_FOUND`, distinct exit codes 4 and 2). `doctor` has never contacted the daemon or
probed the socket; `registration` reporting daemon reachability makes it the first check that does.
This is accepted deliberately: the whole point of the finding is to tell those two states apart, and
that is not answerable from the store alone.

### D3 — The Gatekeeper passage is one source with a machine-checkable boundary

The workaround is written once, delimited by HTML comment markers, and reproduced in `README.md` and
`CHANGELOG.md` (which is the release-notes body). A test asserts every required document carries
both markers and that the passage names the exact `xattr` command. Increment G deletes the marked
region; the test is what makes a half-removal fail loudly instead of leaving stale advice to strip a
security attribute.

`todo.md` item 5 (notarization) gains a line pointing at the markers so the removal step is written
down where the person doing it will be looking.

### D4 — The quick start is made self-contained, and proved by execution

The task-definition step moves into the quick start so the sequence works on a clean workspace with
no Makefile and no adapters. A scenario test executes the quick start's commands against a
temporary workspace and asserts each exits 0.

Constraint: the test must derive its commands **from `README.md`**, not from a copy. A test holding
its own transcription proves the transcription works and lets the README rot independently — which
is the precise failure mode item 37 documents.

Out of scope: a `wtm tasks` command. Real, but it is item 37 growing a new command, and the error
message reaches the user in the moment they need it.

### D5 — The launchd label is derived; the old agent is booted out, not adopted in place

Label becomes `dev.wtm.daemon.<digest>` where `<digest>` is a short hex digest of the resolved
absolute `HOME`. Requirements: stable across runs, filesystem- and launchd-safe, and never colliding
for two distinct `HOME`s in one `gui/<uid>` domain.

Migration, on `install` and on `status`: detect a service bootstrapped under the bare legacy label
whose plist is *this* `HOME`'s, boot it out, publish under the derived label. Detect the legacy
plist file and remove it after the new one is published. Sweep legacy-label `.operation-lock` and
`.transaction` siblings, because D5's own label change is what makes them unrecoverable (§40.2).

A legacy service whose plist is **not** this `HOME`'s is left strictly alone — that is another
`HOME`'s daemon, and silently booting it out would turn a reporting bug into a destructive one.

`status` becomes self-consistent by construction: `state`, `runState`, `plistPath` and `reachable`
all key off the same derived label and the same `HOME`. The status payload gains a field naming the
label so the answer is self-describing, and `docs/04-cli-reference.md` gains the output-field table
it never had.

### D6a — Read commands have no envelope warnings channel

Found during implementation and recorded because it is an asymmetry no document stated. The removal
path warns through the envelope's `warnings` array; the diagnostic envelope hard-codes that array
empty (`packages/cli/src/diagnostics.ts:324`, `:423`). So a read command that reconciles locally
cannot report it the way `removal-coordinator.ts` does — its warning goes to stderr in the existing
`[CODE] message` shape, written such that it survives `--json` while stdout stays exactly one
envelope.

This is a wart, not a design: the two command families disagree about where a non-fatal condition
belongs. Giving the diagnostic envelope a real warnings channel is worth doing, but it changes a
contract shape and belongs to an increment that can carry the compatibility test, not to a bug fix in
a read path.

### D6 — Errors keep their identity through the diagnostics envelope

`toDiagnosticError` learns to preserve a coded error's `code`, `message` and `remediation` instead of
flattening it. The mechanism is the existing WeakMap registration (`packages/cli/src/diagnostics.ts:112`)
or an equivalent structural check — the task picks, with a test proving a `DaemonRegistrationError`
reaches the envelope as `WTM_WORKSPACE_NOT_FOUND` with its own message and exit code 2.

This is deliberately scoped, and the scope stated here in draft — "errors that already carry a valid
`WtmErrorCode`" — was **too loose**. Corrected during implementation: a valid code alone is not
enough, because `code` is what Node stamps on every `ErrnoException`, and an existing safety test
pins that `Object.assign(new Error('provider failed with <secret>'), { code: 'WTM_CONFIG_INVALID' })`
must still flatten. Admitting it on the strength of its code would have turned that test red, and
turning it green would have been precisely the item-39 leak: an arbitrary exception's message
becoming contract text.

The bar is therefore the full required `WtmError` shape — a schema-valid `code`, an explicit
`severity`, and a non-empty `message`. `severity` is the discriminator that matters: it is a
deliberate self-declaration no accidental `ErrnoException` carries, and the errors this decision
exists to preserve already have it. A preserved error is still run through the existing redaction
and bounding, so it gains identity, not an exemption.

Anything failing that bar keeps falling back to `GIT_REPOSITORY_DEGRADED`; making arbitrary
exceptions self-describing at the envelope boundary is how internal detail leaks into a contract,
and item 39 exists because that already happened once.

## Acceptance criteria

Restated from `todo.md` as checkable statements.

1. A user who downloads the archive in a browser finds, in the README install section, why the
   binary is killed and the exact command that fixes it. The same text is in the release body.
   A test fails if the passage is present in one document and absent from another.
2. Following the README quick start top to bottom in a clean workspace with no Makefile produces no
   error. A test executes the README's own commands and asserts it.
3. `Unknown task: <name>` lists the task names that do exist. With no tasks configured, the message
   says how to define one.
4. Under a `HOME` long enough to breach the limit, `wtm daemon install`/`serve` fails with a single
   actionable `WTM_`-coded line naming the measured length and the limit — not a stack trace.
5. No user-facing output on any failure path contains a build-machine path or a stack trace. Proven
   by a test that drives a failing daemon start and asserts the absence of `/Users/runner` and of
   frame markers in both stdout and stderr.
6. `doctor` reports the socket-path headroom before it becomes a failure.
7. Two `HOME`s on one machine do not report each other's daemon. `state`, `runState`, `plistPath`
   and `reachable` always describe the same agent.
8. An agent installed under the legacy fixed label is taken over on the next `install`, with no
   orphaned service, no orphaned plist, and no unrecoverable journal.
9. In an unregistered worktree, `wtm env` fails with `WTM_WORKSPACE_NOT_FOUND` (exit 2) and the
   message naming `wtm init` — not `GIT_REPOSITORY_DEGRADED` and "Diagnostic data source failed."
10. `doctor` distinguishes "the daemon is unreachable" from "this worktree is not registered", as a
    `registration` finding rather than an `adapters` one.
11. A worktree created while the daemon was down is visible without a manual `wtm init`, either
    because the CLI reconciled locally or because the daemon reconciled when it returned. Whichever
    holds is proven by a test.

## Explicitly out of scope

- Notarization (item 5, Increment G). This increment documents the workaround and makes its removal
  verifiable.
- npm channel verification (item 38) — it needs a real publish, not code.
- A `wtm tasks` command (D4).
- Merging the two cwd→worktree lookups (§41).
- Changing the SEA build to strip build paths from stack frames (§39).
- Idle RSS (item 42, Increment H).

## Risks

- **The launchd label change is the riskiest thing in this increment**, because it edits the file
  that owns crash recovery for a transactional, on-disk, cross-process publish protocol. It is
  sequenced last among the code tasks, and the migration sweep is specified as a task requirement
  rather than left to the implementer to notice.
- The out-of-process `*.scenario.ts` suites are host-speed-sensitive: each one hard-codes its own
  timeout constant, so each encodes an assumption about how fast the machine is, and a runner slower
  than a developer laptop fails them nondeterministically. This increment adds more such scenarios
  and so makes that worse. It is not fixed here — the fix is one env-overridable source for those
  timeouts, or a harness that retries on timeout-only failures while still failing hard on assertion
  mismatches, and inventing a retry policy in passing is how a suite starts hiding real races. What
  this increment owes is narrower: new scenarios take their timeout from one shared constant instead
  of adding another literal, so the eventual central fix has fewer sites to reach.
