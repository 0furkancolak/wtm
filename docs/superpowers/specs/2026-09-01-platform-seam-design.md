# Increment C1 — The platform seam

## Status

Approved — 2026-09-01. Implements the C1 half of Increment C in
`2026-08-31-v1-stable-program-map.md`, which covers `todo.md` item 9's macOS and Linux halves.

## What this increment is, and what it is not

Item 9 asks for a product that runs first-class on macOS, Linux and Windows. This increment does
**one** thing toward that: it makes the operating system a *parameter* of WTM rather than an
assumption baked through it, and it lands the Linux backend everywhere Linux is decidable without a
Linux kernel.

**This increment does not claim WTM runs on Linux.** No Linux CI job is added, no Linux binary is
built, and nobody should read a green suite here as evidence that `systemctl --user` bootstraps a
daemon. Everything the Linux backend does is proven the way the launchd backend is already proven —
against fixtures and injected command runners — which establishes that the *decisions* are right and
establishes nothing at all about the kernel. C2 owns that.

Saying so plainly is load-bearing. The failure mode this increment is most likely to produce is a
commit that looks like Linux support, ships a `LinuxPlatformRuntime`, passes 1000 tests, and does
not start.

## Why these pieces are one increment

They share one property: each is a place where WTM currently states a macOS fact as if it were a
universal one, and each of those statements is read by something that must keep working unchanged.
A seam extracted around one of them, and not the others, is not a seam — it is a wrapper around one
call site, and the next platform still has to touch every layer. The set is closed by the question
"what does the daemon need to know about the machine to run?": where its files go, how long a socket
address may be, how to recognise a process it started, and how to make itself start at login.

## The state of the code this replaces

Established by reading, before any of the decisions below:

1. `packages/core/src/paths/daemon-socket.ts` — in **core** — spells the macOS data root as
   `['Library', 'Application Support', 'WTM']` and the socket limit as `104`, which is macOS's
   `sun_path`. Core exports both from its barrel; the CLI and the daemon consume them.
2. `packages/core/src/runtime/process-identity.ts` — in **core** — shells out to BSD
   `ps -ww -p <pid> -o lstart=`. `packages/core/src/analysis/operation-lease.ts` calls it directly,
   so core's cross-process lease logic depends on a macOS `ps` output format. The module's own
   header already anticipates this increment and describes `installProcessStartIdentityReader` as
   the seam it will use.
3. `packages/daemon/src/process-supervisor.ts` and `packages/daemon/src/process-anchor.ts` each
   parse BSD `ps` output with their own regex, for process identity and for process-group liveness.
   The anchor's copy is inside a string program that is written to disk and run by `node`.
4. `packages/daemon/src/runtime-factory.ts` places logs at `~/Library/Logs/WTM` and derives the
   socket path from the data root.
5. `packages/daemon/src/launchd.ts` is 2580 lines. **Roughly four-fifths of it is not about
   launchd**: it is a transactional publisher for a definition file — an operation lock, a journal,
   file-identity checks, atomic publish and removal, and interrupted-transaction recovery. The
   launchd-specific part is small and enumerable: the label, the plist body, the `LaunchAgents`
   directory, the `launchctl` argument vectors, how to read a status out of `launchctl print`, and
   the legacy-label migration.
6. `packages/daemon/src/main.ts:438` refuses every platform but `darwin`.
7. `packages/core/src/plan/external-adapter.ts` branches on `process.platform === 'win32'` in three
   places. Those branches are POSIX-versus-Windows process-group semantics. They are already correct
   for Linux.

Finding 5 is the one that decides the shape of this increment. It means the Linux service backend is
not a second 2500-line module; it is a descriptor.

## Decisions

### D1 — The seam is a package, not a directory inside core

A new workspace package `@wtm/platform`, depending only on `@wtm/protocol`.

It cannot live in core. Item 9's first acceptance criterion is that core is platform-independent, and
a `core/src/platform/` directory containing `launchctl` and `/proc` makes that criterion unsatisfiable
by construction — core would contain the OS-specific imports whether or not they sit in a subfolder.

The dependency graph stays acyclic and gains one node:

```
protocol
   ├── core        (no OS-specific import after this increment)
   └── platform    (all OS-specific knowledge)
          └── consumed by daemon and cli
```

Core never imports `@wtm/platform`. Where core needs a platform fact, it declares a *port type* and
takes an implementation as an argument; the composition roots — the CLI and the daemon — are the only
places that choose a platform. This is the difference between core being platform-independent and
core being platform-indirect.

### D2 — Four ports, named by the question they answer

```ts
interface PlatformRuntime {
  readonly id: 'darwin' | 'linux';
  readonly paths: PlatformPaths;
  readonly socket: SocketAddressPolicy;
  readonly process: ProcessPlatform;
  readonly service: ServiceBackend;
}
```

`selectPlatformRuntime(platform = process.platform, env = process.env, home = homedir())` returns
one, and throws a coded `WTM_PLATFORM_UNSUPPORTED` for anything else — today, `win32`. The three
arguments are all injectable, which is what lets the Linux runtime be constructed and tested on this
macOS machine.

`selectPlatformRuntime` is also where `home` is validated — absolute, then resolved — once, for
every port. `launchd.ts` already does this for itself at `launchdPaths`, and the individual path
resolvers deliberately do not repeat it: a check duplicated into each port is a check that will
eventually disagree with itself, and the composition root is the one place every port passes
through.

Every port is a plain object of functions, not a class hierarchy. There is no shared base class and
no template method: the macOS and Linux implementations have almost nothing in common except their
signatures, and a base class would exist only to be overridden into nothing.

### D3 — Path policy: macOS keeps `~/Library`, Linux follows XDG, and the socket root is separate

```ts
interface PlatformPaths {
  dataRoot: string;      // state.db lives here
  configPath: string;    // the global config.toml
  logRoot: string;
  socketRoot: string;    // the daemon socket lives here
  serviceRoot: string;   // where the service definition is published
}
```

| | macOS | Linux |
|---|---|---|
| `dataRoot` | `~/Library/Application Support/WTM` | `$XDG_STATE_HOME/wtm`, default `~/.local/state/wtm` |
| `configPath` | `<dataRoot>/config.toml` | `$XDG_CONFIG_HOME/wtm/config.toml`, default `~/.config/wtm/config.toml` |
| `logRoot` | `~/Library/Logs/WTM` | `<dataRoot>/logs` |
| `socketRoot` | `<dataRoot>` | `$XDG_RUNTIME_DIR/wtm`, falling back to `<dataRoot>` |
| `serviceRoot` | `~/Library/LaunchAgents` | `$XDG_CONFIG_HOME/systemd/user`, default `~/.config/systemd/user` |

`socketRoot` is a separate field, not a derivation from `dataRoot`, because on Linux it genuinely is
one: `$XDG_RUNTIME_DIR` is normally `/run/user/<uid>`, which is both the correct place for a socket
(tmpfs, cleaned at logout, 0700) and dramatically shorter than any home directory — which is the
same defect Increment B measured on macOS, solved for free on Linux by putting the socket where the
platform says sockets go. The fallback matters: `$XDG_RUNTIME_DIR` is absent in containers and over
`su`, and a daemon that refuses to start there would be worse than one with a long socket path that
the C1 preflight will measure anyway.

**`XDG_CACHE_HOME` is deliberately absent from the table.** Item 9 lists it among the Linux
directory variables, and the first draft of this spec repeated that in acceptance criterion 4 —
which task C1-1 correctly reported as unsatisfiable, because WTM has no cache. Nothing it writes is
reconstructible from something else, which is the definition a cache directory has to meet: the
state database is authoritative, the logs are a record that must survive a cache clear, and the
socket is a live address. `Caches` occurs once in this codebase, in `workspace/discover.ts`, as a
directory to *skip*. Honouring `XDG_CACHE_HOME` would therefore have meant inventing a root nothing
writes to, purely to be able to say the variable is supported. The variable moves nothing, on
either platform, and there is a test that says so.

An XDG variable is honoured only when it is an **absolute** path, per the XDG basedir spec; a
relative value is ignored in favour of the default. This is not pedantry — `XDG_RUNTIME_DIR=tmp`
would otherwise put the socket somewhere relative to the daemon's working directory.

macOS ignores the XDG variables entirely, including when they are set. A macOS user with
`XDG_CONFIG_HOME` exported for some other tool must not find WTM's state silently relocated.

### D4 — The socket limit is a platform fact, and it is 104 on macOS and 108 on Linux

```ts
interface SocketAddressPolicy {
  limitBytes: number;
  boundPathFor(publishedPath: string): string;
}
```

Both numbers are `sizeof(sun_path)` for their platform. Increment B established the macOS number by
measurement and documented why it could not be established by reading the error: Bun's own limit is
118, so the failure does not reproduce in the environment the code is developed in. **The same
caveat applies with more force to the Linux number, which nothing here can measure.** 108 is the
value in `linux/un.h` and has been for the lifetime of the ABI; it is recorded as a documented
constant with its provenance, and C2 verifies it on a kernel. The measurement machinery
(`measureDaemonSocketPath`, `DaemonSocketPathTooLongError`) is already parameterised over the limit
and does not change.

`measureDaemonSocketPath` and the error type move to `@wtm/platform` unchanged in behaviour. The
`daemonDataDirectorySegments` constant does not move — it dies, replaced by `PlatformPaths.dataRoot`.

### D5 — Linux process identity comes from `/proc`, and its start-time string cannot be mistaken for macOS's

`ProcessPlatform` answers three questions, which is exactly what the three existing `ps` call sites
ask:

```ts
interface ProcessPlatform {
  readStartTime(pid: number): Promise<string | null>;              // lease ownership
  inspectProcess(pid: number): Promise<ProcessInspection>;         // supervised task identity
  inspectProcessGroup(pgid: number): Promise<ProcessGroupInspection>; // group liveness
}
```

`null` and `'absent'` keep their current meanings exactly: the process is gone. A reader that cannot
answer for any *other* reason still throws or reports `failed`, because — as `process-identity.ts`
already says — a wrong `null` releases somebody else's lease.

Linux reads `/proc/<pid>/stat`. Two parsing hazards, both of which the implementation must handle and
test, because both are how naive `/proc/stat` parsers break:

- Field 2 (`comm`) is parenthesised and may itself contain spaces **and** parentheses. Every field
  must be located relative to the **last** `)` in the line, never by splitting on whitespace.
- Field 3 (`state`) `Z` means a zombie — which is **not** uniformly treated as absent today, and the
  first draft of this spec said it was. Task C1-3 established the actual state of the code:
  `inspectProcess` and `inspectProcessGroup` ask `ps` for a state column and drop zombies;
  `process-identity.ts`'s lease reader asks for `lstart` *alone*, has no state column, and therefore
  reports a zombie lease holder as **present**. Verified by reading the argument vectors.

  So the rule is per-question, not per-platform: **zombie is absent in `inspectProcess` and
  `inspectProcessGroup`, and present in `readStartTime`.** Making Linux's `readStartTime` treat a
  zombie as absent would have Linux reclaim a lease macOS still holds — a wrong absence, which is
  the single failure this module exists to prevent.

  Whether a zombie lease holder *should* be reclaimable is a real question and it is not this
  increment's. Changing it here would be a behaviour change smuggled into a refactor whose entire
  claim is that macOS behaves identically afterwards, and the exposure is bounded anyway: a zombie
  exists only between exit and reap, and leases already expire. It belongs with lease semantics, not
  with the platform seam.

Start time is field 22, in clock ticks since boot. Boot time alone is not enough to make it unique
across reboots, so the stored string is `<btime>:<starttime>`, where `btime` is read from
`/proc/stat`'s `btime` line. **Both components are decimal digits, so a Linux identity string can
never equal a macOS one** — macOS stores a `ps` `lstart` string such as `Mon Sep  1 12:00:00 2026`.
That property is deliberate and is the reason no state migration is needed: the two formats coexist
in one schema column without a version tag because they cannot collide.

They can still *mismatch* — a `HOME` shared between a macOS and a Linux machine over a network
filesystem holds one `state.db`, and each host reads the other's identity strings as belonging to a
different process. For a supervised-process record that is safe; for a **lease** it is not, because
"different process" means "the holder is gone, reclaim it" and the holder may be alive on the other
host. This increment does not fix that. It is recorded as `todo.md` item 44 and is out of scope
here: the fix is a host identity column, which is a state schema change, and the exposure requires a
shared network home with concurrent destructive operations from two operating systems.

The macOS implementation is the existing code, moved. Its `ps` argument vectors, its regexes and its
`stableEnvironment()` are not rewritten, retyped or "improved" — the point of this task is that macOS
behaviour is byte-identical afterwards.

`process-anchor.ts` is the exception and stays macOS-shaped for now: its `ps` call lives inside a
program serialised into a string and executed by a separate `node`, so it cannot import a port. The
anchor is rendered per platform in C2, and this increment leaves it alone rather than half-doing it.
That is a stated gap, not an oversight.

### D6 — The service backend is a descriptor over the existing transaction machinery

`launchd.ts`'s transactional publisher is not launchd knowledge and must not be written twice. It is
generalised in place over a backend descriptor:

```ts
interface ServiceBackend {
  labelFor(home: string): string;
  definitionPath(paths: { serviceRoot: string; label: string }): string;
  renderDefinition(options: ServiceDefinitionOptions): string;
  commands(input: { uid: number; label: string; definitionPath: string }): ServiceCommandSet;
  interpretStatus(result: ServiceCommandResult): ServiceStatusState;
  legacyMigration?: LegacyMigration;   // macOS only; Linux has no legacy to migrate
}
```

> **The sketch above is smaller than what shipped, and the code is authoritative.** Implementing it
> surfaced six more things that are genuinely backend knowledge — the directory plan (including
> which link must be owner-only, which had been a hardcoded `endsWith('/LaunchAgents')` buried in
> the safety walk), the definition suffix, the default `PATH`, two refusal wordings, and the command
> name a failure names — plus `runState`, which is a published envelope field. The real interface is
> `packages/platform/src/service/types.ts`; `ports.ts` re-exports it rather than restating it.

The macOS descriptor is the existing behaviour with nothing added or removed, including the
per-`HOME` label from Increment B and the legacy `dev.wtm.daemon` migration. The Linux descriptor
renders a systemd user unit into `~/.config/systemd/user/wtm-daemon-<hash>.service` and drives
`systemctl --user daemon-reload / enable / start / stop / disable / show`.

The hash is the same per-`HOME` derivation macOS uses. Linux does not have macOS's constraint that
forced it — one uid there normally has one `HOME` — but `HOME` can be overridden on Linux too, and a
label that differs by platform in *derivation* rather than only in *spelling* is a second rule to
keep true. The unit name is uglier than `wtm-daemon.service`; `wtm daemon status` reports the exact
name, which is what a user needs in order to type `systemctl --user status <name>`.

The command runner stays injected (`LaunchdCommandRunner` generalises to `ServiceCommandRunner`), so
the Linux lifecycle is exercised here against a fake `systemctl` in exactly the way the macOS
lifecycle is already exercised against a fake `launchctl`. That is evidence about the argument
vectors and the state machine. It is not evidence that systemd accepts the unit.

The rename must not become a rewrite. Every existing launchd test keeps passing against the macOS
descriptor, unmodified except for import paths and renamed symbols. **A test changed to accommodate
the refactor is a regression that has been hidden**, and any such change must be reported rather than
made.

### D7 — Core's remaining platform knowledge, and what is deliberately left

After this increment core contains no macOS-specific import. It still contains three
`process.platform === 'win32'` branches in `plan/external-adapter.ts`, which choose POSIX process
groups over Windows semantics. Those stay:

- they are already correct for Linux, which is the platform this increment adds;
- item 9 assigns Windows process semantics to the Windows increment, where they will be decided
  together with Job Objects rather than piecemeal here;
- touching them now would mean changing untested-on-Windows code with no way to verify either
  branch, which is how a refactor introduces a defect it cannot see.

The structural guard test (D8) therefore forbids *macOS-specific* knowledge in core, and records
these three sites as a named, reviewed exception rather than as an unexplained hole.

`operation-lease.ts` stops importing `process-identity` directly. It takes a `readStartTime` port,
supplied by the caller. `installProcessStartIdentityReader` — a module-global mutable seam — is
removed rather than repurposed: a global that any test can install is a global that a test can
forget to restore, and the increment that makes the platform explicit is the wrong place to keep an
implicit one.

### D8 — A test that fails when macOS re-enters core

A structural test over `packages/core/src/**` and `packages/protocol/src/**` that fails on:

- the literals `Library/Application Support`, `Library/Logs`, `LaunchAgents`, `launchctl`, `launchd`,
  `systemctl`, `systemd`, `/proc/`;
- spawning `ps`;
- `process.platform` and `os.platform()` outside the reviewed `external-adapter.ts` exception list.

Comments are not exempt. A comment saying `~/Library/Application Support/WTM` is a statement about
where files go, and when it survives a move it is wrong documentation in the one package that is
supposed not to know.

The exception list is a literal array in the test with a reason string per entry, so adding an
exception is a visible edit in a diff rather than a regex loosened by one character. The list is
pinned by count as well as by content, so a *fourth* `win32` branch appearing in
`external-adapter.ts` fails the guard rather than being absorbed by the existing exception.

The guard also forbids importing `@wtm/platform` from core or protocol — added by task C1-5, beyond
this list as first written. It belongs: it enforces D1 directly, and the literal and command checks
below only catch a platform WTM *inlines*, not one it imports.

### D9 — `assertSupportedRuntime` accepts Linux, and says what Windows is waiting for

`darwin` and `linux` pass. `win32` is refused with a message that names the Windows increment rather
than saying "requires macOS", which is now false. The refusal carries a coded error so it reaches the
JSON envelope as an error rather than as a bare string — Increment B established that rule.

### D10 — `wtm doctor` reports the platform's differences, because item 9 requires it

Item 9's last acceptance criterion is that platform-specific differences are reported by
`wtm doctor`. A new `platform` check reports the selected runtime id, the service manager it will
use, the resolved data/log/socket roots, and the socket limit in force. It is a `pass`-or-`error`
check: `error` only when `selectPlatformRuntime` refuses the host.

This is additive to the `doctorChecks` tuple, which Increment B made the single source for both the
schema enum and the ordering, so the JSON contract change is one array entry and the contract test
covers it. `docs/04-cli-reference.md`'s doctor table gains the row in the same task — the same table
went stale in Increment B because the task that added checks did not own the file.

### D11 — `package.json` keeps `"os": ["darwin"]`

It is a truthful statement today and stays one until C2 proves otherwise. Changing it here would
publish an npm package that installs on Linux and then does not run, which is a worse failure than
refusing to install. The keyword list and the description likewise keep saying macOS. C2 changes all
three together with the evidence that justifies them.

### D12 — The internal `LAUNCHD_*` codes keep their names; the user-visible messages do not

Task C1-4 reported that a systemd failure currently raises `LAUNCHD_COMMAND_FAILED`. Checked: those
codes are **internal**. They are not in `packages/protocol/src/errors.ts`, they appear nowhere in
`docs/18-errors-json-contract.md`, and `packages/cli/src/commands/daemon.ts` maps every one of them
onto a real `WtmErrorCode` before anything reaches an envelope. No user sees them, and renaming them
is not a contract change.

What a user *does* see is `launchdError`'s five hardcoded strings — "The launchd user domain is
unavailable.", "launchd is only available on macOS.", and three more. On Linux those are simply
false. **Those become platform-aware; the internal names stay.**

The asymmetry is deliberate. `launchd.test.ts` references the internal codes 99 times, and that file
being byte-unchanged through a 2580-line refactor is the strongest evidence this increment has that
macOS behaviour survived. Spending it on a rename that changes nothing a user can observe would be a
bad trade. C2 works in this code with a real systemd and can rename deliberately, with the test
changes as the point rather than as collateral.

## Acceptance criteria

1. A `@wtm/platform` package exists, depends only on `@wtm/protocol`, and is covered by
   `bun run typecheck` and `bun run build`.
2. `selectPlatformRuntime` returns a complete runtime for `darwin` and for `linux` from this macOS
   host, and refuses `win32` with a coded error.
3. `packages/core/src/**` and `packages/protocol/src/**` contain no macOS-specific import, literal,
   or spawned command, proven by the D8 test — and that test fails when the check is removed from
   core and re-added, verified by performing the removal.
4. Linux path resolution honours `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_RUNTIME_DIR` when
   absolute, ignores them when relative or empty, and falls back to the basedir defaults when
   unset — each case tested. macOS path resolution ignores all of them. `XDG_CACHE_HOME` moves
   nothing on either platform (D3).
5. The Linux socket limit is 108 bytes and the macOS limit is 104, both flowing from the same
   measurement code, with the existing `WTM_SOCKET_PATH_TOO_LONG` error naming whichever is in force.
6. `/proc/<pid>/stat` parsing survives a `comm` containing spaces and parentheses, reports a zombie
   as absent, reports a missing `/proc` entry as absent, and reports any other failure as a failure
   rather than as absence — each case tested against fixture content.
7. A Linux start-time string and a macOS start-time string can never be equal, proven by a test over
   the two formats.
8. The macOS service lifecycle passes every pre-existing launchd test with no change beyond imports
   and renamed symbols. Any test whose *assertions* had to change is reported, not changed.
9. The Linux service lifecycle installs, reports status, and uninstalls against an injected fake
   `systemctl`, including the failure paths the macOS backend already covers.
10. `assertSupportedRuntime` accepts `linux`, and `win32`'s refusal names the Windows increment.
11. `wtm doctor` reports a `platform` finding; `docs/04-cli-reference.md` lists it.
12. `bun run lint`, `bun run typecheck` and the full `bun run test` are green on macOS, with no test
    deleted or weakened.

### D13 — One JSON field differs by platform, deliberately and temporarily

Item 9's acceptance criteria include "JSON contract platformlar arasında aynı kalıyor", and after
this increment it does not: `wtm daemon status` carries `plistPath` on macOS and not on Linux.

That is the cost of obeying the program map's rule 4 — JSON changes are additive only. The field had
to stop being the field to read, because a systemd unit is not a plist and naming it one would be
false. The alternatives were both worse: renaming it outright breaks the rule, and emitting it on
Linux with a `.service` path in it tells a reader something untrue in order to keep a shape.

So the contract differs by exactly one field, that field is documented as deprecated, and C2 removes
it — at which point the criterion is met. Recording it here because task C1-8 correctly pointed out
that nothing did: a criterion quietly unmet is indistinguishable from a criterion forgotten, and the
box in `todo.md` stays unticked until the deprecation is gone.

## Out of scope

- Any Linux CI job, Linux binary target, or change to `package.json`'s `os` field — C2.
- `process-anchor.ts`'s embedded `ps` — C2, stated as a gap in D5.
- Windows anything, including the `win32` branches in `external-adapter.ts` — Increment D.
- The shared-`HOME`-across-platforms lease hazard — recorded as `todo.md` item 44.
- inotify or watcher behaviour: `StructuralWatcher` uses `fs.watch`, which is already cross-platform;
  whether its *semantics* match on Linux is a real-kernel question and belongs to C2.

## Risks

**The seam is shaped by macOS habits.** Mitigated by writing the Linux backend in the same increment
rather than after it, which is the only reason to accept C1's lack of user-visible value.

**The launchd refactor breaks something 2580 lines deep.** Mitigated by generalising rather than
rewriting, by keeping every existing test unmodified, and by treating a required test change as a
finding to report. This is the single riskiest task in the increment and it gets a wave to itself.

**Linux code that is green here and broken on a kernel.** Not mitigated — that is what C2 is. The
mitigation available now is to be exact about which claims this increment supports, which is why the
opening section says so before anything else.
