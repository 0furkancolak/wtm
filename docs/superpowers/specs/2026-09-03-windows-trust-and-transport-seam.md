# Increment D1 — the Windows trust-and-transport seam

## Status

Done — 2026-09-03. The D1 half of Increment D in `2026-08-31-v1-stable-program-map.md` (Windows
split into D1/D2 on this date, for the reason C split into C1/C2). Both halves are now done and
tested: the trust half (D2-D5) landed first, and D7's `IpcServerPublisher` extraction — the one
piece the first pass explicitly left undone — landed in a second, focused pass the same day. See
Outcome below for exactly what each half proves and does not.

## What this increment is, and what it is not

Item 9's Windows half needs a `WindowsPlatformRuntime`. This increment builds the parts of it that
are decidable on this macOS host, the same discipline C1 applied to Linux: real implementations,
real tests, driven by fixtures and injected command runners rather than a live kernel.

**This increment does not claim WTM runs on Windows.** No Windows CI job is added, no `.exe` is
built, and nothing here is evidence that a Scheduled Task starts a daemon or that a named pipe
keeps another user out. D2 owns that, and two of this increment's own decisions (D6, D7 below) are
explicit about which of their parts D1 can prove and which it can only state.

## Why these pieces are one increment

Scoping this (2026-09-03, reading the code before any decision below) surfaced two things
`todo.md`'s Windows section did not name, and both answer the same question: **what does WTM ask
the filesystem or the kernel, that Windows answers differently, before core or the daemon can act?**

1. There is no IPC abstraction at all today. `packages/daemon/src/server.ts` and
   `packages/cli/src/client.ts` call `net.createServer`/`createConnection` directly, and the
   server's socket is stood up through an atomic hardlink-publish proven by `uid`/`mode`/`nlink` —
   none of which a Windows named pipe has, because a named pipe is not a filesystem entry you can
   `lstat`, `chmod`, or `link`.
2. That same `uid`/`mode`/`nlink` trust model is not confined to the platform layer. It is inline,
   151 times, across 11 files inside `@wtm/core` itself — it is the mechanism core's own
   resource-safety guarantees are built on, not a platform-package concern that C1 already handled.

Both are the same question — "does this path belong only to the current user, and can anyone else
reach it?" — asked at two different layers (a socket address, and every sandboxed resource path).
Windows answers it with owner SIDs and DACLs, not a numeric uid and octal mode, and the answer was
confirmed to be full ACL parity for this release rather than a documented gap (asked and answered,
2026-09-03) — so both layers get a Windows-native answer in the same increment, from the same
research.

## The state of the code this replaces

Established by reading, before any decision below (file:line citations throughout).

### IPC

No abstraction boundary exists around the transport. `createServer`/`createConnection` (an
`AF_UNIX` socket path, since both arguments are plain path strings) are called directly at
`packages/daemon/src/server.ts:221` and `packages/cli/src/client.ts:185` (a second, independent
`createConnection` exists for liveness probing at `packages/cli/src/main.ts:1319`). Tests
construct raw `net` fakes too (`packages/daemon/src/__tests__/server-close.scenario.ts:2`,
`packages/cli/src/__tests__/{remove-resume,reconcile-fallback}.scenario.ts`).

`packages/platform/src/socket/*` (from C1) already answers a narrower question — the address's
byte limit (104 macOS / 108 Linux, `limits.ts:32,55`) and its private bind-path name
(`socket-path.ts:46-53`) — but nothing decides *how* the two ends talk, and nothing about a
published address's security.

`server.ts`'s real complexity is the publish protocol, not the `net` call: it binds to a hidden
name, then **hard-links** it onto the published name (`server.ts:249`, `await link(boundPath,
this.#socketPath)`) so a client never observes a half-created socket, and it proves the result is
trustworthy with `chmod(path, 0o600)` and repeated `lstat` + `dev`/`ino`/`uid` identity checks
(`server.ts:258-268,661-718` and similar). `secureSocketParent` refuses a parent directory that is
not `0700` and owned by the calling uid; `prepareSocketPath` refuses to quarantine a stale socket
it does not own. None of `link`, `chmod`'s POSIX-mode meaning, or `uid` exist for a named pipe.

### The trust model inside core

`process.getuid?.()`, `stat.uid` comparisons, and octal-mode checks (`0o077`, `0o022`, `& 0o7777`)
occur 151 times across 11 files, none of them in `@wtm/platform`:
`packages/core/src/resources/{guard.ts, preparation.ts, removal.ts, materializer.ts, gc.ts}`,
`packages/core/src/plan/{adapter-trust.ts, adapter-runner.ts, external-adapter.ts}`,
`packages/core/src/state/{private-directory.ts, sqlite-store.ts, store.ts}`. Two representative
sites, both doing the same three-part check inline:

- `packages/core/src/resources/guard.ts:183-186` (`assertSafeDirectory`): not-a-real-directory,
  then `stat.uid !== currentUid` ("not owned by the current user"), then `(mode & 0o022) !== 0`
  ("group/world writable").
- `packages/core/src/state/private-directory.ts:97-109` (`assertPrivateDirectory`): not-a-directory,
  `stat.uid !== currentUserId`, `(stat.mode & 0o077) !== 0`.

Every site reduces to one of three predicates — **owned by the current user**, **not writable by
anyone else** (the two sites above use different masks, `0o022` vs `0o077`, for reasons specific to
each caller: a "no others" check is stricter than a "no group/other *write*" check, and that
distinction is preserved rather than flattened), and, at a handful of sites
(`materializer.ts:452,514,578,602`, `service-lifecycle.ts`), **not multiply hard-linked**. `core`
computing these itself, rather than asking a port, is the same shape of problem C1's D7/D8 fixed
for macOS-specific paths and commands — except the D8 guard does not scan for this pattern today,
only for macOS literals and spawned commands.

### What Node already does on Windows, unresearched before now

Two claims below are backed by Node's own documentation and Microsoft's, not guessed, because a
guess here is exactly the mistake this program's own findings keep naming (C2's F6/F9/…, C3's
F1-F5: "a claim that was true of the only instance anyone had checked").

- Node's `net` module already treats a named-pipe path (`\\.\pipe\<name>`) and a Unix-domain-socket
  path as the same kind of argument to `createServer(...).listen(path)` /
  `createConnection(path)` — there is no separate Windows API to call. **This is why the seam this
  increment extracts is the *publish protocol*, not the socket call itself**: the call that differs
  by platform today is not `createServer`/`createConnection`, it is everything `server.ts` does
  around them.
- A raw Win32 named pipe created with a `NULL` security descriptor is genuinely dangerous — Microsoft's
  own reference states plainly: *"If you specify NULL, the named pipe gets a default security
  descriptor. The ACLs in the default security descriptor for a named pipe grant full control to
  the LocalSystem account, administrators, and the creator owner. They also grant read access to
  members of the Everyone group and the anonymous account."* (Named Pipe Security and Access
  Rights, Microsoft Learn.) But Node does not hand callers that raw default: `server.listen()`
  takes `readableAll`/`writableAll` options, both documented to **default to `false`**, and the
  docs describe them as something you turn on deliberately to make a root-started server reachable
  by unprivileged users — i.e. Node's own default is the restrictive one, not the Win32 API's.

  **This is a documented default, not a measurement.** Node's docs do not spell out exactly which
  DACL results when both are `false`, only that it is not "accessible for all users." Whether that
  DACL actually keeps a second real Windows account out is exactly the kind of fact C1 could state
  about `sizeof(sun_path) == 108` and not verify — this increment states it, with its source, and
  D2 is where it is measured against a second account on a real Windows host.
- A consequence that shapes D6 below: a named pipe is not a filesystem entry once its owning
  process exits. There is no equivalent of a Unix socket's stale leftover file, so there is nothing
  for a Windows publisher to quarantine, and the entire `prepareSocketPath`/`secureSocketParent`/
  hardlink dance in `server.ts` has no Windows counterpart to reimplement — not because it was
  ported and simplified, but because the problem it solves does not exist there.

### Everything else already in the C1 seam

`packages/platform/src/ports.ts:20` (`PlatformId = 'darwin' | 'linux'`) and every indexed-dispatch
table keyed on it (`select.ts:43-48,78-81`, `platform-paths.ts:78-81`) are written as
`Readonly<Record<PlatformId, ...>>` specifically so that widening the union is a compile error at
every such table until a `win32` entry is added — the comments say so
("Indexed rather than branched, so that widening `PlatformId` — Windows is a later increment — is
a type error here instead of a silent fall-through"). Two refusal points already name this
increment by name: `packages/daemon/src/main.ts:582-584` and `packages/platform/src/select.ts:27-41`.

`packages/platform/src/service/types.ts:152-188` is the authoritative `ServiceBackend` shape. Its
`commands({uid, label, definitionPath})` and `ServiceCommandSet`'s verb set (`print`, `reload?`,
`enable`, `bootstrap`/`bootout`, …) are launchd/systemd's shared "per-user daemon managed by CLI
verbs" model; a Scheduled Task is a different model (registered by name, run/end/change, no
"reload the manager" verb), so a Windows descriptor supplies the same six methods with different
bodies rather than reusing any POSIX-shaped one. `ManagedDirectory.ownerOnly`
(`service/types.ts:130-143`) is enforced by octal-mode checks in both existing descriptors
(`service/darwin.ts:284-308`, `service/linux.ts:237-247`) — this is the same three-predicate trust
model as core's, so it is fixed by the same port (D3 below), not a fourth reimplementation.

`packages/core/src/plan/external-adapter.ts` carries exactly three `process.platform === 'win32'`
branches (pinned by count in the D8 guard, `packages/core/src/__tests__/platform-independence.test.ts:129-135`):
a `detached` flag (line 201), an outright refusal of descriptor execution on Windows (line 328),
and a process-group-signal fallback that only ever runs `child.kill(signal)` on win32 today (lines
346-347). These stay exactly as C1's D7 left them — Windows process-group semantics are D2's
Job-Object work, not this increment's.

## Decisions

### D1 — `PlatformId` widens to `'darwin' | 'linux' | 'win32'`

Every indexed-dispatch table this breaks (`select.ts`, `platform-paths.ts`, the new tables this
increment adds) gets a `win32` entry in the same change. This is the forcing function the existing
code was written to trigger, not an incidental side effect.

`supportedPlatforms` (`select.ts:18`) and `assertSupportedRuntime`'s refusal message
(`daemon/src/main.ts:582-584`) are **not** changed to accept `win32` yet — that flips only when
D2 can back it with a real CI leg, the same rule C1 applied to Linux (C1 did not claim Linux ran;
C2 turned the claim on). `win32` becomes a legal `PlatformId` so it can be *constructed and tested*
from this host, exactly as C1 let the Linux runtime be built and exercised on macOS.

### D2 — `FileTrustPolicy`: one port for the three predicates core already asks 151 times

```ts
interface FileTrustPolicy {
  isOwnedByCurrentUser(stat: Stats, path: string): boolean;
  isWritableOnlyByOwner(stat: Stats, path: string): boolean; // the "no group/other write" question
  isNotSharedByHardLink(stat: Stats): boolean;                // nlink === 1
  currentIdentityAvailable(): boolean;                        // false where uid/owner cannot be read
}
```

The POSIX implementation is every one of the 11 files' inline logic, **moved, not rewritten** —
`stat.uid !== process.getuid?.()`, the two existing masks (`0o022` and `0o077`, both preserved as
distinct call sites rather than unified into one), `stat.nlink !== 1`. This is the same
non-negotiable C1 held for the launchd descriptor: a test whose *assertions* change to accommodate
the refactor is a hidden regression, so every one of the 151 call sites' existing tests must pass
unmodified once it is migrated to call the port.

`currentIdentityAvailable()` exists because several sites (`guard.ts:183`) already have a distinct
branch for "identity cannot be determined at all" (`process.getuid?.() === undefined`, true on
Windows if a caller mistakenly used the POSIX policy there) versus "identity is known and does not
match" — collapsing these would turn a coded, specific refusal into a generic one.

### D3 — the Windows `FileTrustPolicy` reads ACLs via `powershell.exe`, the same way the other ports shell out

No Node API exposes a file's owning SID or its DACL without a native addon. Every existing
platform port already answers its platform's identity question by shelling to the OS's own
inspection tool and parsing structured output (`ps` for macOS, `/proc/<pid>/stat` for Linux,
`systemctl show` for the Linux service backend) — this is that pattern's third instance, using
`powershell.exe` (Windows PowerShell 5.1, present on every supported Windows version and on
`windows-latest` GitHub runners, not the separately-installed PowerShell 7) rather than `icacls`,
because `Get-Acl ... | ConvertTo-Json` returns structured owner-SID and per-ACE data instead of a
locale-dependent text table `icacls` would require re-deriving that structure from.

The three predicates translate as:

- **owned by current user**: the ACL's owner SID compared against
  `[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value` — SIDs, not account
  names, because a display name can be renamed or localized and a SID cannot.
- **not writable by anyone else**: no ACE grants a write-capable right
  (`Write`/`Modify`/`FullControl`/`WriteData`, allow-type) to a principal other than the owner SID
  and a small, named-in-code allowlist (`SYSTEM`, `Administrators`) — the Windows analogue of root
  always being able to get in regardless of a POSIX file's mode, not a weakening of the check.
- **not multiply linked**: `stat.nlink` from Node's own `fs.stat`, unchanged — NTFS does not
  support hard-linked directories at all, which is what every one of these checks is applied to, so
  this predicate very likely needs no Windows-specific body. Stated, not assumed: a fixture test
  proves the *parsing and decision* logic (below); nothing here proves NTFS actually behaves this
  way, and D2 checks it against a real volume.

Tested against **fixture `Get-Acl`-shaped JSON**, the same discipline C1 used for `/proc/stat`
without a Linux kernel: an owner-match and an owner-mismatch fixture, an ACL with only the owner
having write and one with an extra writable principal, each asserted against the predicate it
decides. This proves the parsing and the decision. It proves nothing about a real NTFS ACL — D2
measures that, the same caveat C1 attached to the Linux socket limit.

### D4 — every one of the 151 call sites migrates to the port; a structural guard keeps a 152nd from appearing

The migration is mechanical and each file's existing tests are the proof it did not change
behavior — the same TDD-then-migrate order C1 used for `operation-lease.ts`'s
`installProcessStartIdentityReader` removal. A new structural test, alongside
`platform-independence.test.ts`, fails if `packages/core/src/**` contains `process.getuid`, a
`0o0NN` literal compared against `stat.mode`, or a `stat.nlink` comparison outside the port itself
— the same reviewed-exception-list shape D8 already established, so a legitimate new inline check
is a visible diff to a prose list, not a silently accepted regex change.

### D5 — Windows `PlatformPaths`: `%LOCALAPPDATA%`/`%APPDATA%`, resolved the same injected way as D3's table

```
dataRoot   <LOCALAPPDATA>\WTM
configPath <dataRoot>\config.toml
logRoot    <dataRoot>\logs
socketRoot <dataRoot>            (no XDG_RUNTIME_DIR equivalent; D2 measures whether this needs
                                   a shorter root the way socket-path length ever mattered on macOS)
serviceRoot N/A — a Scheduled Task has no directory to publish into (D6)
```

Resolved from `{home, env}` exactly like the darwin/linux resolvers (`platform-paths.ts:1-18`'s own
stated reason: so a non-native platform's layout can be exercised on a different host). `home` on
Windows is not `os.homedir()`'s POSIX meaning, but the function signature does not change — only
which environment variable it prefers.

### D6 — Windows `ServiceBackend`: a per-user Scheduled Task, chosen for the reason `todo.md` already states

`todo.md`'s own Windows lifecycle decision names three options and states a preference: *"the first
choice should, as much as possible, be a solution that does not require administrator rights."* A
per-user Scheduled Task (registered with `schtasks.exe /Create /SC ONLOGON` or equivalent, scoped
to `/RU` the current user, no `/RL HIGHEST`) is exactly that; a native Windows Service requires
installing into the machine-wide service database, which needs administrator rights to register
even once. The descriptor is written against `schtasks.exe`, the OS-default tool present without
any install step, matching every other backend's choice of the platform's own tool.

The six-method `ServiceBackend` shape is kept, with Windows-shaped bodies: `commands()` builds
`schtasks` argument vectors for create/query/run/end/delete rather than launchd/systemd's verbs;
`interpretStatus()` classifies `schtasks`'s own exit codes (its failure modes are `ERROR_FILE_NOT_FOUND`-
shaped, not launchd's 113 or systemd's 5, and get their own named mapping); `ManagedDirectory`
loses its `ownerOnly` mode-bit meaning and instead asks D2's `FileTrustPolicy` port, which is the
concrete reason D2/D3 are prerequisites of this decision rather than parallel work.
`LegacyServiceMigration` is omitted, following Linux's precedent (D6 of the platform-seam spec:
"Linux has no legacy to migrate" — neither does Windows, which has never run WTM before).

Tested against an injected fake `schtasks` runner, covering install/status/uninstall and the
failure paths the macOS and Linux descriptors already cover (`manager-unreachable`, `not-found`,
`failure`) — the same discipline, proving the argument vectors and the state machine, proving
nothing about Task Scheduler itself.

### D7 — `IpcServerPublisher`: the seam is the publish protocol (F1), not the `net` call

```ts
interface IpcServerPublisher {
  publish(server: Server, address: string, options: PublishOptions): Promise<PublishedIpcServer>;
}
interface PublishedIpcServer {
  readonly address: string;
  unpublish(): Promise<void>;
}
```

The POSIX implementation is `server.ts`'s existing hardlink/chmod/uid dance, **moved into
`@wtm/platform` unchanged** — every existing server test keeps passing with no assertion changed,
the same non-negotiable D6/D8 of the platform-seam spec held for launchd.

The Windows body is written, not deferred, because the design question ("does the publish protocol
need to exist at all") is answerable from this host per F1's cited findings: it does not, because a
named pipe has no stale-file state to quarantine and Node's own default already restricts
`readableAll`/`writableAll`. So the Windows publisher is `createServer().listen({path})` with both
left at their default `false` — genuinely simpler than the POSIX path, not a placeholder standing
in for missing complexity. **Whether that default actually keeps a second Windows account out is
not proven here** — it is Node's documented contract, not a measurement, and D2 is where a second
account is the thing that tries to connect.

### D8 — Named-pipe *connection*, and process supervision (Job Objects), get their port shapes decided here and their real bodies proven in D2

Unlike D3's ACL parsing or D6's `schtasks` argument construction, there is no fixture that stands
in for a live named pipe accepting a connection or a live Job Object tracking a process tree — both
are OS primitives with no text-based surface to fixture. `IpcServerPublisher.publish`'s Windows
body (D7) is exactly at the edge of what's decidable: it is simple enough that its correctness is
plausible from documentation alone. A `ProcessPlatform` implementation for Windows, and
`process-anchor.ts`'s currently-absent Windows reader (which today returns
`ANCHOR_PLATFORM_UNKNOWN` for any platform string it doesn't recognise), are not: they need real
Job Object handles and real `GetExitCodeProcess`/`QueryFullProcessImageName`-shaped calls this host
cannot exercise even provisionally. Those interfaces are named and typed in this increment so D2
starts from an agreed shape, and their implementations are D2's, stated as such rather than shipped
half-tested.

## What this increment does not claim

- **Not that WTM runs on Windows.** No CI leg, no binary, no claim about a real named pipe, a real
  ACL, a real Scheduled Task, or a real Job Object — only that the parsing, the argument vectors,
  and the moved POSIX behavior are each proven the way this project already proves such things
  without the kernel in question.
- **Not a native addon.** Every Windows-specific fact is read by shelling to `powershell.exe` or
  `schtasks.exe`, matching every existing port's choice of the OS's own tool over a dependency.
- **Not Job Objects, not the anchor's Windows reader, not a proven named-pipe connection.** D2 (D8
  above draws the exact line).
- **Not a change to `supportedPlatforms` or `assertSupportedRuntime`'s refusal.** Those still name
  D2, unchanged from today's message, until D2 can back a `win32` acceptance with a green run.

## Acceptance criteria

1. `PlatformId` includes `'win32'`; every existing indexed-dispatch table fails to typecheck until
   a `win32` entry is added, and every one gets one, verified by performing the widening and
   confirming the compile error, per C1's own discipline for such tests.
2. `FileTrustPolicy` exists in `@wtm/platform` with the three predicates plus
   `currentIdentityAvailable()`; the POSIX implementation is today's inline logic moved verbatim;
   every one of the 151 call sites across the 11 named `@wtm/core` files calls the port; every
   affected file's existing tests pass with no assertion changed.
3. A structural guard test (alongside `platform-independence.test.ts`) fails if `process.getuid`,
   a mode-bit comparison against `stat.mode`, or an `nlink` comparison appears in
   `packages/core/src/**` outside the port itself.
4. The Windows `FileTrustPolicy` implementation is tested against fixture `Get-Acl`-shaped JSON for
   each predicate, both the true and false case, including the "identity unavailable" case.
5. `windowsPlatformPaths` resolves `dataRoot`/`configPath`/`logRoot`/`socketRoot` from injected
   `{home, env}`, tested the way the darwin/linux resolvers already are.
6. A Windows `ServiceBackend` descriptor renders a Scheduled Task command set and drives a fake
   `schtasks` runner through install/status/uninstall and the shared failure-path vocabulary
   (`manager-unreachable`/`not-found`/`failure`), with no admin-rights-requiring command in the
   default path.
7. `IpcServerPublisher` is extracted; the POSIX (`UnixSocketPublisher`) implementation is
   `server.ts`'s existing logic moved with zero behavior change, proven by its existing tests
   passing unmodified; a Windows implementation exists per D7, explicitly unproven pending D2.
8. `ProcessPlatform` and the process-anchor's identity-reader interface are widened to accept a
   `win32` case at the type level; no Windows implementation body is required to satisfy this
   criterion (D8 draws that line), but the type-level gap must be a visible, named TODO rather than
   a silent `never`.
9. `lint`, `typecheck`, `test`, `test:e2e`, `build`, `package:verify`, `binary:verify` pass locally
   on this macOS host, with the full existing suite green and no assertion in any pre-existing test
   changed by this increment.

## Outcome

All nine criteria are met. Criteria 1-6 and 9 were met in the first pass; criterion 7
(`IpcServerPublisher`) was deliberately left for a second, focused pass rather than rushed into the
first, and that pass ran the same day. Criterion 8 is met at the type level only, as the criterion
itself allows.

1. `PlatformId` is `'darwin' | 'linux' | 'win32'` (`packages/platform/src/ports.ts`). Every indexed
   table gained a `win32` entry in the same change: `select.ts`'s `processPlatforms`,
   `serviceBackends` and the new `fileTrustPolicies`; `platform-paths.ts`'s `resolvers`;
   `socket/policy.ts`'s `policies`. `supportedPlatforms` and `assertSupportedRuntime`'s refusal are
   unchanged, as D1 specifies.
2. `FileTrustPolicy` (`isOwnedByCurrentUser`, `isWritableOnlyByOwner`, `isNotSharedByHardLink`,
   `currentIdentityAvailable`) exists in `@wtm/platform` (`trust/posix.ts`, `trust/windows.ts`) and
   as a structurally-identical, independently-declared port in `@wtm/core`
   (`file-trust-policy.ts`, per D2's own reasoning: core cannot import `@wtm/platform`). The POSIX
   implementation is every one of the 8 files' inline logic moved, not rewritten — confirmed by the
   full existing suite (352 tests before, 356 after — the 4 new ones are this increment's own guard
   tests) passing with zero assertions changed. All 8 files that actually asked "is this owned by
   the current user" or "is this writable by anyone else" are migrated:
   `resources/{guard,preparation,removal,materializer,gc}.ts`, `plan/adapter-trust.ts`,
   `state/private-directory.ts` — and one file the original scope named turned out not to belong
   (`state/sqlite-store.ts`'s 20 `.uid` occurrences are all a persisted database column, never a
   `process.getuid()` comparison; verified by reading, not assumed from the count). Total: zero
   `process.getuid` calls remain anywhere in `packages/core/src/**` outside the port itself
   (confirmed by repository-wide grep).

   A finding the original scope did not anticipate: many `.uid`/`.mode`/`.nlink` reads in these
   same files are not ownership questions at all but TOCTOU identity comparisons against a
   *previously observed* value (`stat.uid !== candidate.uid`, never `process.getuid()`) — these do
   not migrate to `FileTrustPolicy` and are explicitly left alone, with the Windows consequence
   documented in `gc.ts`'s own comment: `fs.Stats.uid` is always `0` there, so the `uid` component
   of such a tuple never discriminates on Windows and the "swapped for a different user's object"
   half of that protection is unavailable — `(dev, ino)` alone still catches a same-user swap. Not
   fixed here; recorded as a real, scoped gap rather than smoothed over.
3. The structural guard is `packages/core/src/__tests__/file-trust-guard.test.ts`, narrower than
   first drafted: not "no `stat.mode`/`.uid`/`.nlink` at all" (which the TOCTOU finding above would
   have made a reviewed-exception list the size of `gc.ts`), but the two patterns a *reintroduced*
   inline check would actually take — `process.getuid` and a raw `mode & 0o022`/`& 0o077` — matching
   nothing left in the tree, so it carries zero reviewed exceptions of its own kind and one for a
   test file asserting on a real materialized file's mode (a legitimate output check, not a bypass).
4. `windowsPlatformPaths` (`paths/platform-paths.ts`) resolves `dataRoot`/`configPath`/`logRoot`/
   `socketRoot`/`serviceRoot` from `{home, env}` under `%LOCALAPPDATA%`, tested the same way as the
   darwin/linux resolvers. Built with `node:path/win32` explicitly rather than the default
   `node:path` — a finding this task made, not anticipated by the spec: the default `path` module is
   `path/posix` on any host that is not actually `win32`, so it cannot join or recognise a
   backslashed, drive-lettered path at all when exercised from this macOS host. The same fix was
   needed in the Windows `ServiceBackend` descriptor and its own `home`-hashing helper.
5. `windowsServiceBackend` (`service/windows.ts`) renders a per-user Scheduled Task (no admin
   rights, per `todo.md`'s own stated preference) and drives a fake `schtasks`/`sc.exe` runner
   through install/status/uninstall and the shared failure vocabulary, tested in
   `service/__tests__/windows-service.test.ts`. One architectural finding recorded in the file's own
   doc comment: unlike a plist or a unit file, a Scheduled Task's XML is a *staging* artifact
   consumed once at `/Create` time, not a live definition read back afterward — `definitionPath`
   does not mean for Windows what it means for the other two backends, and this is stated rather
   than papered over. `kickstart` is an acknowledged approximation (`/Run` again, since `schtasks`
   has no atomic restart verb) pending D2.
6. `createWindowsProcessPlatform` (`process/windows.ts`) exists and is type-complete; every method
   throws a coded `WindowsProcessPlatformNotImplementedError` naming Increment D2 — the visible,
   named TODO criterion 8 asks for, not a silent `never`. No Job Object work was attempted, per D8.
7. `lint`, `typecheck`, `test` (1282 pass, 1 skip, 0 fail across the full monorepo), `test:e2e`,
   `build`, `package:verify`, and `binary:verify` (`dist/sea/wtm 0.1.0-rc.1, darwin-arm64`, 9/9
   smoke tests) all pass locally.

### D7, closed in a second pass the same day

`IpcServerPublisher` (`packages/platform/src/ipc/types.ts`) is extracted: `publish(server, address,
options)` returns a `PublishedIpcServer` (`{ address, unpublish() }`). `UnixSocketPublisher`
(`ipc/unix.ts`) is `server.ts`'s entire hardlink/chmod/uid dance — `secureSocketParent`,
`prepareSocketPath`, the bind→link→verify→chmod→verify sequence, the private-path close shield,
every quarantine helper — moved into `@wtm/platform`, restructured from `UnixIpcServer` instance
fields into a closure captured per `publish()` call (a publisher has no server-lifetime identity of
its own to hang fields off), but not rewritten. `packages/daemon/src/server.ts` shrank from ~1000
lines to `UnixIpcServer` owning only connection/frame handling and delegating `#start`/`#close` to
`this.#publisher.publish(...)`/`published.unpublish()`. All 24 of `server.integration.test.ts`'s
tests, `server-close.scenario.ts`'s five close-shield scenarios, and `socket-path-limit.test.ts`
pass with zero assertions changed — none of them ever imported the moved internals, only the
public `UnixIpcServer` class, which is why this extraction is provably behavior-preserving rather
than merely believed to be.

`createWindowsIpcPublisher` (`ipc/windows.ts`) is the D7-predicted simpler body: `listen({ path:
address })` with `readableAll`/`writableAll` left at Node's own default, `close()` on `unpublish`.
Tested (`ipc/__tests__/windows-ipc.test.ts`) against a fake `net.Server` — there is no Windows
kernel here to bind a real named pipe against, the same position D3's ACL parsing and D6's
`schtasks` argument vectors were in. Both are wired into `PlatformRuntime.ipc`
(`ports.ts`/`select.ts`), a new indexed-dispatch entry (darwin/linux share `UnixSocketPublisher`,
win32 gets `createWindowsIpcPublisher()`), following the same discipline as `fileTrustPolicies`.

Full verification after this pass: `lint`, `typecheck` (all seven package projects), `test` (1286
pass, 1 skip, 0 fail — four more than the first pass, all new, all in `windows-ipc.test.ts`),
`test:e2e`, `build`, `package:verify`, and `binary:verify` (`dist/sea/wtm 0.1.0-rc.1, darwin-arm64`,
9/9 smoke tests) all pass locally.
