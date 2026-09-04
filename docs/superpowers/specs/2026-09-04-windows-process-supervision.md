# Increment D2, pass 1 — a real Windows `ProcessPlatform`, still unproven against a kernel

## Status

In progress — 2026-09-04. The first pass of Increment D2 in `2026-08-31-v1-stable-program-map.md`
(D1/D2 split, `2026-09-03-windows-trust-and-transport-seam.md`). D1 left the Windows
`ProcessPlatform` a named, visible TODO (its own D8) because process identity and process-group
liveness have no fixture equivalent — no captured text this file could parse the way `Get-Acl` JSON
or a `schtasks` report can be captured. This pass writes the real implementation anyway, proven the
way D1 proved everything else it could not run: against fixtures and an injected command runner, not
a live kernel. What is still missing after this pass — `supportedPlatforms` accepting `win32`, a
Windows CI leg, and everything that leg would be the first to discover — is named in its own section
below, not silently left for a reader to notice.

## Why this is `ProcessPlatform`, not Job Objects

`todo.md`'s own Windows checklist asks for "Windows Job Objects or a safe equivalent." A Job Object
is a kernel handle: nothing durable to persist, nothing a crashed-and-restarted daemon could ask
about again. Every other identity this project persists — `(pid, processStartTime)` for a lease,
`(pid, pgid, processStartTime, commandFingerprint)` for a supervised process — is instead a value
read back from the OS on demand, and that is what makes `ManagedProcessSupervisor.recover()` work
after a daemon restart. A Job Object handle could not fill that role no matter how it was wrapped.

`inspectProcessGroup`/`signalProcessGroup`'s actual job in this codebase is answered instead by
**the process tree rooted at the pid the codebase already calls `pgid`.** That identification is not
a Windows-specific stretch: `ManagedProcessSupervisor` (`process-supervisor.ts:410`) and the anchor
itself (`process-anchor.ts`) already refuse a handshake unless `identity.pgid === identity.pid`, on
every platform — the anchor is `spawn`ed `detached: true`, which makes it a POSIX session leader for
free on macOS/Linux, and the invariant this project enforces is exactly "the group is the tree rooted
at the leader's own pid," never a foreign or child-assigned value. Windows has no kernel-tracked id to
read that back from, so this pass tracks the tree itself, from `Win32_Process.ParentProcessId`,
instead of asking a kernel that keeps no such answer. `taskkill /PID <pid> /T /F` is the Windows tool
for terminating exactly that tree in one call, matching the tool-per-platform precedent D3 and D6
already set (`Get-Acl`, `schtasks`) over writing a native addon.

## Findings

- **F1 — the codebase-wide `pgid === pid` invariant makes the substitution correct, not merely
  convenient.** Confirmed by reading, not assumed: `process-supervisor.ts:410` rejects the anchor's
  own `READY` handshake unless `readyIdentity.pgid === pid`, and `process-anchor.ts` (pre-existing,
  its own `identity.pgid !== process.pid` check) refuses to report ready otherwise. Nothing in this
  codebase ever inspects a *foreign* pgid — every call site's `pgid` traces back to a leader process
  asking about its own tree. A Windows reader that treats "the group" as "the tree rooted at this
  pid" is therefore answering the same question every other platform's reader answers, not a
  weaker one.
- **F2 — `signalProcessGroup` did not exist as a port method before this pass, and its absence was a
  real gap, not an oversight caught early.** `ManagedProcessSupervisor`'s constructor
  (`process-supervisor.ts:169`, before this pass) hardcoded
  `options.signalProcessGroup ?? ((pgid, signal) => process.kill(-pgid, signal))` as its own default
  — a POSIX syscall with no seam at all, unlike `inspectProcess`/`inspectProcessGroup`, whose
  defaults already delegated to `hostProcessPlatform()`. `runtime-factory.ts`'s composition root
  wired the latter two through the selected `PlatformRuntime` but never `signalProcessGroup`, so the
  real daemon's kill path was POSIX-only underneath a seam that looked complete. `win32` could not
  have terminated anything even with a correct `ProcessPlatform`, because the one call that
  terminates a group never asked the port at all.
- **F3 — a straightforward tree walk gets the "root already exited, orphan still alive" case wrong
  unless it starts from the parent index, not from the root's own record.** First written gated on
  `byPid.get(pgid)` existing (mirroring how the walk finds a root before descending); on Windows the
  root process can exit while its children survive as orphans, because Windows never clears a dead
  parent's recorded `ParentProcessId` the way POSIX reparents orphans to init. Gating on the root's
  own liveness would have reported the whole tree absent — a **wrong absence** — in exactly the
  moment this method is most likely to be asked something interesting: right after
  `signalProcessGroup` was told to kill the tree, checking whether it actually died. Fixed by walking
  from `childrenByParent.get(pgid)` directly; the root's own record is consulted only to decide
  whether `pgid` itself belongs in the reported set, never to gate whether its children do.
- **F4 — the querying process is briefly a member of the tree it is asked about, when the asker is
  the tree's own root.** `Get-CimInstance Win32_Process` necessarily enumerates itself, mid-execution
  — `powershell.exe` is a real process with a real `ParentProcessId` at the moment the snapshot is
  taken. This is invisible from the daemon's side (`windows.ts`'s `inspectProcessGroup`): the daemon
  is a different ancestor than the anchor being inspected, so its own transient `powershell.exe`
  never lands inside the anchor's subtree. It is not invisible from the anchor's own side: when the
  anchor asks about its own tree (an operation `process-anchor.ts` already had a POSIX-only version
  of, via `ps`'s self-exclusion), the transient PowerShell process it just spawned to ask the question
  is, briefly, its own child. The anchor's inline Windows reader excludes it by pid, mirroring the
  darwin reader's existing `inspector.pid` exclusion; the platform port has no such exclusion because
  it does not need one, and the difference is explained in both files' own comments rather than left
  for the asymmetry to look like an inconsistency.
- **F5 — `taskkill`'s documented exit code for "already gone" (128) is the only thing in this pass
  that is a claim about the real tool rather than a decision this codebase controls**, in the same
  sense D1's F2 named Node's `readableAll`/`writableAll` default a documented claim rather than a
  measurement. `ManagedProcessSupervisor` already special-cases "no such process" by checking
  `error.code === 'ESRCH'` (`process-supervisor.ts`'s `isNoSuchProcess`) — untouched by this pass —
  so the Windows implementation normalizes `taskkill`'s exit 128 into that same `code: 'ESRCH'` shape,
  which is what lets every existing call site's platform-agnostic handling stay platform-agnostic.
  Whether 128 is really what a live `taskkill.exe` reports for a missing pid on every supported
  Windows version is exactly what a Windows CI leg would be the first thing to confirm or refute.

## Decisions

### E1 — `ProcessPlatform` gains `signalProcessGroup(pgid, signal): void`

Synchronous, matching `process.kill`'s own contract (succeed or throw before returning, never
later) — `ManagedProcessSupervisor` calls it without `await` at every existing site and some of those
sites depend on a *synchronous* throw to distinguish "already gone" from every other failure
(`process-supervisor.ts:530,557,636,647`). The POSIX implementations
(`process/darwin.ts`, `process/linux.ts`) are `process.kill(-pgid, signal)` moved verbatim from the
supervisor's own former default — zero behavior change, and every existing
`process-supervisor.test.ts` assertion (which always injects its own `signalProcessGroup` and so
never exercised this default) still passes unmodified, plus `runtime-factory.test.ts`'s wiring test.

### E2 — the daemon's default `signalProcessGroup` is migrated onto the port (F2's gap, closed)

`process-supervisor.ts`'s module-level `signalProcessGroup` free function now delegates to
`hostProcessPlatform().signalProcessGroup(...)`, the same shape `inspectProcess`/`inspectProcessGroup`
already had; `runtime-factory.ts`'s composition root now wires it from the selected
`platformRuntime.process` alongside the two readers it already wired, closing exactly the drift risk
its own comment already named for the other two methods.

### E3 — Windows `ProcessPlatform`: one `Get-CimInstance Win32_Process` shape, two queries

A single-pid `-Filter` query answers `readStartTime`/`inspectProcess`; an unfiltered query answers
`inspectProcessGroup`, which needs the whole table to walk parent/child edges (there is no
"give me this tree" query to ask for instead — the same reason the Linux `inspectProcessGroup` scans
all of `/proc` rather than asking the kernel for pgid members directly). `CreationDate` is requested
already reshaped to round-trip (`"o"`) format in the `Select-Object` clause, the same "reshape before
`ConvertTo-Json`, not after" choice `trust/windows-powershell.ts` made for a SID, so the parser never
has to decide what PowerShell's default `/Date(...)/` serialization means. A parent/child edge is
accepted only if the child's `CreationDate` is not earlier than the parent's (F3's pid-reuse guard:
Windows does not invalidate a dead process's recorded `ParentProcessId`, so a later, unrelated
process that reuses that numeric pid must not be absorbed into the tree just because the number
still matches).

### E4 — `signalProcessGroup`'s Windows body is `taskkill /PID <pgid> /T /F`, unconditionally forceful

Node's own `ChildProcess.kill()` already force-terminates unconditionally on Windows regardless of
the signal argument passed to it — a documented Node limitation, not something this pass introduces
— so WTM's graceful/forceful two-phase shutdown was already collapsing to one phase on Windows before
this pass existed, in the one adapter code path (`external-adapter.ts`'s win32 branch) that already
ran on Windows. Using `/F` unconditionally here is not a downgrade from what "SIGTERM" would have
accomplished; `/T` is the part that matters, reaching the whole tree a plain `TerminateProcess` on
the root pid alone would not. Exit code 128 is read as "already gone" (F5) and re-thrown as an
`Error` whose `code` is `'ESRCH'`, so `isNoSuchProcess` needs no platform branch of its own.

### E5 — the anchor's inline Windows reader is a duplicate, proven against the port by fixture, not by a live process

Every other platform's anchor reader in this file is proven two ways: against a real live process
(macOS, since this host is one) or against a captured directory fixture (Linux's `/proc`). Neither
exists for a single PowerShell command's JSON stdout, so `AnchorReaderSpec` gains
`windowsQueryRunner` — set only by `compileAnchorReaders`'s direct, non-serialized test path, the
same restriction `procRoot` already carries, and absent from the real anchor's `WTM_ANCHOR_SPEC`
environment variable by construction (it only ever carries `platform`). Both sides of the drift
check are fed the identical captured JSON, and the three
`__tests__/process-anchor.test.ts` tests added by this pass require identical output from the port
and the anchor's own copy, the same discipline the existing macOS/Linux drift tests already apply.

## What this pass does not claim

- **Not that `win32` is a supported platform.** `supportedPlatforms` (`select.ts`) and
  `assertSupportedRuntime`'s refusal are unchanged. `createWindowsProcessPlatform` is constructible
  and unit-tested, and nothing in the product calls it yet.
- **Not a Windows CI leg.** No `windows-latest` runner, no `.exe`, and this pass makes no claim about
  what a real `powershell.exe`, a real `Get-CimInstance`, or a real `taskkill.exe` actually reports —
  every finding above that is a claim about the tool rather than a decision this codebase makes (F5
  above, and the whole of E3/E4's parsing) is documented, not measured, the same standing caveat
  every other Windows port in this project already carries.
- **Not a proof that `taskkill /T` and a live Job Object produce the same cleanup guarantee.** They
  are not claimed to: POSIX's own pgid-based kill has never had Job-Object-style "auto-terminate
  when the last handle closes" semantics either — nothing in this codebase calls `setsid` for that
  reason, and an orphaned POSIX group survives a daemon crash exactly as an orphaned Windows tree
  would. This pass's Windows behavior matches what POSIX already does, not a weaker version of what
  Job Objects could have provided.
- **Not the remaining `external-adapter.ts` Windows gaps.** Descriptor-adapter execution is still
  refused outright on `win32` (unrelated to process supervision, a separate item in `todo.md`); its
  `signalAdapterProcessGroup` single-child fallback is untouched, since nothing reachable today
  exercises it.
- **Not path canonicalization, drive letters, UNC paths, or NTFS junction/symlink semantics** — all
  still open items in `todo.md`'s Windows checklist, independent of process supervision.

## Acceptance criteria

1. `ProcessPlatform` gains `signalProcessGroup(pgid, signal): void`; `darwin.ts`/`linux.ts` implement
   it as `process.kill(-pgid, signal)`, byte-identical to the supervisor's former default; every
   existing test that exercises the default path (there were none — every existing test injects its
   own) is unaffected, and every test that injects its own continues to.
2. `process-supervisor.ts`'s module-level default and `runtime-factory.ts`'s composition-root wiring
   both route `signalProcessGroup` through `PlatformRuntime.process`, closing F2's gap.
3. `createWindowsProcessPlatform` implements all four `ProcessPlatform` methods for real: identity
   and group inspection via `Get-CimInstance Win32_Process`, termination via `taskkill /T /F`,
   normalizing "already gone" to `code: 'ESRCH'` on both the group-inspection and termination paths.
4. `inspectProcessGroup` finds a live orphaned descendant even when the root pid's own process has
   already exited (F3), proven by a fixture test.
5. `AnchorReaderSpec` gains a `win32` dialect whose `readIdentity`/`readGroupMembers` agree with the
   platform port's own decision over the same captured JSON, proven the same way the macOS/Linux
   drift tests already are; the anchor's self-query exclusion (F4) is proven by its own fixture test,
   distinct from the port's (which needs none).
6. `lint`, `typecheck`, `test`, `test:e2e`, `build`, `package:verify`, `binary:verify` pass locally on
   this macOS host, with the full existing suite green and no assertion in any pre-existing test
   changed by this pass.

## Outcome

All six criteria are met by this pass. `packages/platform/src/ports.ts`'s `ProcessPlatform` carries
`signalProcessGroup`; `packages/platform/src/process/{darwin,linux}.ts` each add the byte-identical
POSIX body; `packages/platform/src/process/windows.ts` is a full implementation (previously every
method threw a named `WindowsProcessPlatformNotImplementedError`, now removed along with that class)
proven by 17 fixture tests in `__tests__/windows-process.test.ts`, including F3's orphan-survives-
root-exit case and F5's `taskkill` exit-code handling. `process-supervisor.ts` and `runtime-factory.ts`
route the default through `hostProcessPlatform()`/`platformRuntime.process` respectively (E2).
`process-anchor.ts`'s inline `anchorReaderSource` gained a `windows` reader object and a
`spec.windowsQueryRunner` test seam, dispatched for `spec.platform === 'win32'`; three new tests in
`__tests__/process-anchor.test.ts` prove it agrees with the port over identical fixture JSON and
correctly excludes its own transient query process (F4). `lint`, `typecheck` (all seven package
projects), and `test` (1306 pass, 1 skip, 0 fail — 20 more than D1's closing count, all new, all in
this pass's own test files) pass locally; `test:e2e`, `build`, `package:verify`, and `binary:verify`
are unaffected by this pass's scope and were re-run to confirm.

**What remains before D2 can close**: flipping `supportedPlatforms` to accept `win32`, standing up a
real `windows-latest` CI leg, and fixing whatever that leg is the first to find — almost certainly
including things well outside this pass's scope (path handling, packaging, the SEA build for `.exe`).
D1's own rule for when a platform's acceptance may flip — "only when a real CI run can back it" —
applies here unchanged, and flipping it before that leg exists would be exactly the unverified claim
this whole program's discipline exists to prevent. That is deliberately a separate, later decision,
not a loose end of this one.
