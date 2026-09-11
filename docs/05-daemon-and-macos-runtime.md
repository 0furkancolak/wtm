# Daemon and Platform Runtime

> The filename is historical and retained to preserve existing links. This document covers
> macOS, Linux and the experimental Windows backend.

## Which platform, and what has been verified where

WTM selects one `PlatformRuntime` at startup — `@wtm/platform`'s `selectPlatformRuntime` — and
everything below asks it where files go, how long a socket address may be, how to recognise a
process, and how to register a service. There are three source backends:

| | macOS | Linux | Windows, experimental |
| --- | --- | --- | --- |
| Service manager | launchd, `launchctl` | systemd user manager, `systemctl --user` | Task Scheduler, `schtasks` |
| Definition | LaunchAgent plist | systemd user unit | XML staging file and registered task |
| Process identity | `ps -o lstart=` | `/proc/<pid>/stat` | CIM creation time and command fingerprint |
| Transport | Unix domain socket | Unix domain socket | Named pipe |
| Distribution | arm64/x64 prerelease archives | No Linux release archive | No Windows release archive or installer |

CI configures the same lint, typecheck, test, e2e, build, package and binary gates on macOS
arm64/x64, Linux x64 and Windows x64. Previous Linux native runs have exercised a real ELF
standalone executable, daemon IPC, anchored tasks and trusted external adapters. A configured
job or a previous green run does not establish that the current revision passes; consult its
[CI run](https://github.com/0furkancolak/wtm/actions/workflows/ci.yml). Windows native acceptance
remains incomplete and its backend is experimental.

The source `package.json` declares `"os": ["darwin", "linux", "win32"]`, checked against the
configured CI platform matrix. That is package eligibility, not a support or release claim.

Current evidence and distribution limits:

- **Linux x64 only.** There is no Linux arm64 runner or published build.
- **glibc only.** `ubuntu-latest` is glibc. musl and Alpine are unproven and unclaimed.
- **Published standalone assets are macOS-only.** The published `v0.1.0-rc.1` release contains
  Darwin arm64/x64 archives and checksums. Source build support does not imply a Linux or Windows
  release archive, Homebrew tap or Windows package-manager channel.
- **The systemd lifecycle is not integration-tested**, for the reason given under
  [the systemd user unit](#linux-the-systemd-user-unit).

Windows selection is implemented. Its native process-tree cleanup, ACL/pipe isolation and
service-recovery evidence must be completed before claiming the same acceptance as macOS.
Other unrecognized operating systems are refused with `WTM_PLATFORM_UNSUPPORTED`.

`wtm doctor`'s `platform` check reports the selected runtime, its service manager, its resolved
data, log and socket roots, and the socket limit in force. It is the first thing to read when WTM
and a reader disagree about where WTM's files are.

## Implementation choice

V1 uses TypeScript on Node.js 24 LTS.

Node's native `fs.watch()` maps directory watches to FSEvents on macOS and to inotify on Linux, so a separate Rust/Swift watcher is not justified before profiling.

## Process model

The per-user service manager starts `wtmd`. The daemon holds the workspace watcher registry,
reconciliation and finite-job queues, SQLite state store, platform IPC server and managed-process
supervisor. macOS and Linux supervise process groups; Windows uses an identity-checked tree.

External adapters are not resident processes.

## Where WTM keeps its files

Each platform follows its own convention:

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Data root (`state.db`) | `~/Library/Application Support/WTM` | `$XDG_STATE_HOME/wtm`, default `~/.local/state/wtm` | `%LOCALAPPDATA%\WTM`, default `<home>\AppData\Local\WTM` |
| Global config | `<data root>/config.toml` | `$XDG_CONFIG_HOME/wtm/config.toml`, default `~/.config/wtm/config.toml` | `<data root>\config.toml` |
| Logs | `~/Library/Logs/WTM` | `<data root>/logs` | `<data root>\logs` |
| IPC root | `<data root>` | `$XDG_RUNTIME_DIR/wtm`, falling back to `<data root>` | Named-pipe namespace derived from the data root |
| Service definition | `~/Library/LaunchAgents` | `$XDG_CONFIG_HOME/systemd/user`, default `~/.config/systemd/user` | XML staging under `<data root>\service`; registration in Task Scheduler |

Path rules:

- **The socket directory is its own field, not a derivation of the data root.** On Linux it
  genuinely is one: `$XDG_RUNTIME_DIR` is normally `/run/user/<uid>`, which is both where the
  platform says sockets belong — tmpfs, `0700`, cleared at logout — and far shorter than any home
  directory, which is the address-length defect macOS had to be measured for. The fallback is
  load-bearing rather than defensive: the variable is absent inside containers and across `su`, and
  refusing to start there would be worse than a long path the preflight measures anyway.
- **An XDG variable counts only when it holds an absolute path**, which is what the base directory
  spec says to do with anything else. `XDG_RUNTIME_DIR=tmp` would otherwise place the socket
  relative to whatever working directory the service manager started the daemon in, so a client and
  a daemon reading the same variable could still disagree about the address. An empty value is
  treated as unset, as the spec asks.
- **macOS ignores the XDG variables entirely, including when they are set.** A macOS user with
  `XDG_CONFIG_HOME` exported for some other tool must not find WTM's state relocated the next time
  their shell profile changes; the daemon would come up with an empty workspace and no explanation.
- **Windows accepts `LOCALAPPDATA` only when it is absolute.** An unset or relative value uses
  the home-based fallback. Windows does not adopt XDG paths.
- **`XDG_CACHE_HOME` moves nothing.** WTM writes no cache. Nothing it stores is
  reconstructible from something else — the database is authoritative, the logs are a record that
  must survive a cache clear, and the socket is a live address — so honouring the variable would
  have meant inventing a directory nothing writes to in order to be able to say it is supported.

## Service definition

`wtm daemon install`, `uninstall` and `status` are driven by the selected platform's service
manager. The backends are descriptors over one transactional publisher — an operation lock, a
journal, file-identity checks, atomic publish and removal, and interrupted-transaction recovery —
so shared publication and recovery rules stay separate from each manager's commands.

### macOS: the LaunchAgent

`wtm daemon install` installs a per-user LaunchAgent under:

```text
~/Library/LaunchAgents/dev.wtm.daemon.<digest>.plist
```

`<digest>` is a SHA-256 over the resolved absolute `HOME`, truncated to 128 bits of hex. A launchd
service name is `gui/<uid>/<label>`, so a constant label made every `HOME` under one uid the same
service: a second `HOME` could not bootstrap its own agent at all, and `wtm daemon status` answered
from whichever agent had got there first while naming this `HOME`'s plist. Deriving the label is
what makes `state`, `runState`, `plistPath` and `reachable` describe one and the same agent.

`install` and `status` take over an installation made under the earlier bare `dev.wtm.daemon`
label when its plist is this `HOME`'s: the old service is booted out, the definition is republished
under the derived label, and the old plist -- along with any operation lock or transaction journal
named after the old label -- is removed. `uninstall` boots out and deletes that same
definition, since an agent under the older name is this `HOME`'s agent under an older name. A
bare-label service whose plist belongs to another `HOME` is left strictly alone; it is that
`HOME`'s daemon.

The reverse-DNS prefix can still change before public release if the final project identifier
changes.

The LaunchAgent invokes the resolved `wtmd` binary/script and restarts it on unexpected failure. Installation never requires root.

`ProcessType` is `Adaptive`, not `Background`. launchd throttles a Background job's CPU and disk I/O, and its children inherit that throttle. Earlier per-candidate port probes exceeded their timeout under it, and dev servers inherited the same throttling. The current default endpoint probe batches candidates through a bounded helper; the daemon still needs ordinary interactive scheduling.

macOS may withhold disk access from a background agent. The executable is signed under one stable identifier (`dev.wtm.cli`) so the grant is not invalidated by every rebuild — but WTM asks for nothing up front, and names the grant only on evidence: a registered directory that exists and refuses to open. A timeout is not that evidence. A `git` that overran its bound on a volume answering slowly is indistinguishable from a denied one until the directory is opened directly, and telling somebody to hand a background agent every file on their disk on the strength of a timeout is advice too large to give on a guess.

### Linux: the systemd user unit

Two claims are separated here, because they carry different weight.

**What CI proves.** The CLI selects this backend on Linux, drives `/usr/bin/systemctl`, and
classifies what comes back — including reporting an unreachable user manager as a named condition
rather than as a generic failure. That runs on the CI kernel.

**What CI does not prove.** The lifecycle itself — install, enable, start — is not
integration-tested. A GitHub runner has no logind user session, so there is no user manager to
accept a unit, and isolating a test by `HOME` cannot manufacture one: a running user manager was
started with the login `HOME`, so a unit written under a test's temporary `HOME` is invisible to it.
The unit file's contents, the argument vectors and the output parsing are covered by unit tests
against an injected fake `systemctl`, exactly as the launchd backend has always been covered against
a fake `launchctl`. That is a written limitation, not a skipped test.

`wtm daemon install` publishes a user unit under:

```text
~/.config/systemd/user/wtm-daemon-<digest>.service
```

`<digest>` is the same SHA-256 over the resolved absolute `HOME` that the launchd label uses.
Linux does not have the constraint that forced the derivation on macOS — a launchd service name is
`gui/<uid>/<label>`, so one uid with two `HOME`s had one service slot, while systemd's user manager
is already per-session. `HOME` can still be overridden here, and a rule that holds by derivation on
one platform and by coincidence on the other is two rules to keep true. The unit name is uglier
than `wtm-daemon.service`; `wtm daemon status` reports it exactly, which is what a user needs in
order to type `systemctl --user status <name>` themselves. There is no legacy name to migrate,
because there has never been a released Linux installation.

The lifecycle drives `systemctl --user` and nothing else:

```text
show --property=LoadState --property=ActiveState --property=SubState <unit>
show --property=Version                 # the user manager itself
daemon-reload
enable / disable <unit>
start / stop / restart <unit>
```

Five of those need a word of explanation, and each is a decision rather than a translation of the
launchd command set:

- **`daemon-reload` after publishing.** systemd caches unit files; a definition written without it
  stays invisible until something else reloads. launchd has no equivalent, because it reads the
  plist at bootstrap time.
- **`disable` on uninstall.** Without it, removal leaves the `default.target.wants` symlink that
  `enable` created, pointing at a unit file that is no longer there.
- **`show` rather than `status`.** `show` prints exactly the properties it is asked for; parsing a
  human-readable `status` report is the mistake the launchd backend already refuses to make.
  `LoadState=not-found` is how systemd says it does not know the unit — through a command that
  exits `0`, which is why the backend interprets the output rather than the exit code alone.
- **`show --property=Version` against the manager.** It fails when there is no session bus to talk
  to: inside a container, over `su`, on a host with lingering disabled. That is the same
  distinction `launchctl print gui/<uid>` draws between "no service" and "no session", and the two
  are reported differently because their remedies differ. A user sees
  `The systemd user domain is unavailable.` — `WTM_DAEMON_UNAVAILABLE`, exit 4, the same code and
  status macOS reports for the same condition — and the usual remedy is
  `loginctl enable-linger "$USER"`, which gives the account a user manager that does not depend on
  a login session. Foreground commands need none of this.

  systemd does not spend an exit status on a bus failure; it exits 1, like a dozen ordinary
  refusals. The command runner classifies the condition from stderr, in the same layer that already
  knows `systemctl` 5 and `launchctl` 113 both mean "no such service" — what a manager's failure
  *means* is knowledge about that manager. `systemctl` is also run with the bus variables
  (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) and the unit-lookup variables (`HOME`,
  `XDG_CONFIG_HOME`) passed through from this process; a name that is absent stays absent, because
  sd-bus reads an empty `DBUS_SESSION_BUS_ADDRESS` as a configured address that does not work, which
  is a worse answer than no address at all.
- **Exit code `5`.** systemd's `EXIT_NOTINSTALLED`. `stop` and `disable` answer with it for a unit
  that is already gone, which is an absence rather than a failure — the same classification
  `launchctl`'s `113` gets, made in the same place.

The unit itself, with the paths abbreviated:

```ini
[Unit]
Description=WTM daemon for /home/you
Documentation=https://github.com/0furkancolak/wtm

[Service]
Type=exec
ExecStart="/home/you/.local/bin/wtm" "daemon" "serve"
WorkingDirectory=/home/you
Environment="HOME=/home/you" "PATH=<the installing shell's PATH, sanitized>"
StandardOutput=append:/home/you/.local/state/wtm/logs/daemon.log
StandardError=append:/home/you/.local/state/wtm/logs/daemon.error.log
Restart=on-failure
RestartSec=1
TimeoutStopSec=5
UMask=0077

[Install]
WantedBy=default.target
```

`Type=exec` rather than `simple` so that `systemctl start` fails when the executable cannot be run
at all, instead of reporting success and leaving the failure to be discovered by the client that
cannot reach the socket. `Restart=on-failure` is launchd's `KeepAlive{SuccessfulExit: false}`: a
daemon that exited cleanly was asked to. `TimeoutStopSec` is `ExitTimeOut` and `UMask=0077` is
`Umask 63` written the way systemd writes it. launchd's `ProcessType` has no counterpart, because
systemd does not throttle a user unit's CPU or I/O by default — which is the state `Adaptive`
exists to ask launchd for. `Type=exec` and `StandardOutput=append:` both require systemd 240
(2018) or newer.

Both platforms retry a failed startup every 10 seconds, indefinitely: `RestartSec=10` and
`StartLimitIntervalSec=0` on Linux, `ThrottleInterval` `10` on macOS — the same interval stated in
each manager's own terms rather than left to the distro's default rate limit. But not every startup
failure is worth retrying. Both definitions set `WTM_DAEMON_SUPERVISED=1`, and `wtm daemon serve`
reads it to tell a permanent failure — a coded error a person has to clear, such as a socket path
that does not fit — from a transient one. A permanent failure then exits `0`: launchd's
`KeepAlive{SuccessfulExit: false}` and systemd's `Restart=on-failure` both restart only a
*non-zero* exit, so exiting `0` is what makes the manager leave the daemon stopped instead of
retrying a condition no retry can clear. `wtm doctor` reports the recorded reason, and
`wtm daemon install` starts the daemon again once it is fixed. Run by hand — without
`WTM_DAEMON_SUPERVISED` set — the same failure keeps its normal exit class.

Two escapes in the rendered unit are not optional. `%` introduces a specifier systemd expands
everywhere in a unit file, so a `HOME` containing one would silently become a different path; `$`
introduces variable expansion inside `ExecStart`, and a `"` or a `\` inside a quoted argument would
end it early. A newline is refused outright rather than escaped: in a plist it is ordinary text,
here it would start a new directive, and no value WTM passes legitimately contains one.

One directory permission differs from macOS deliberately. Every directory WTM manages is checked
for `(mode & 0o022) === 0` — no group or other *write* — which is what stops another user planting
a definition this daemon would then execute. macOS additionally requires `(mode & 0o077) === 0` on
the directories it creates, which costs nothing there because it creates `~/Library` subdirectories
at `0700`. `~/.config` is `0755` on every machine with the standard umask, and `systemctl enable`
creates `~/.config/systemd/user` the same way, so requiring `0700` would mean refusing to install
on essentially every Linux host, or tightening a directory that belongs to systemd's own tooling.
The unit *file* is still checked for `(mode & 0o077) === 0`, so its contents stay unreadable by
other users inside a `0755` directory.

### Windows: the experimental Scheduled Task

The Windows backend renders a per-user, least-privilege Scheduled Task and registers it with
`schtasks`. It requires native Windows PowerShell and Task Scheduler. The guarded XML file
under the service root is staging for registration; Task Scheduler owns the live task.
`definitionPath` therefore does not by itself prove which command is registered.

Status and command classification have fixture coverage, but complete native install, restart,
interrupted-transaction recovery and uninstall evidence is still required. Do not assume that
`schtasks /Run` provides launchd or systemd restart semantics, or that safe XML publication alone
establishes scheduler recovery. WTM does not install an elevated system-wide Windows service.

### Shared service contract

`wtm daemon install` waits for the daemon to answer through IPC before it reports success, and both `install` and `status` report `reachable`. A service manager's running state alone does not establish that WTM can answer a command.

On macOS and Linux, `wtm daemon install` restarts a service that is already loaded. The definition names the executable by path, so replacing a build may leave the definition byte-identical while the previous binary keeps running. Restarting allows the newly installed daemon to recover its SQLite state. Windows restart equivalence remains part of the native acceptance work above.

The service backends target the current user; they do not require a root/system service.

## Watching scope

WTM watches only registered workspaces and repository administrative roots associated with those workspaces.

It does **not** recursively watch the user's entire home directory.

A workspace registration stores:

```text
workspace root
known repository roots
known Git common directories
known linked worktree paths
```

This allows discovery even when a new linked worktree is created outside the workspace root: the main repo's Git administrative directory changes and reconciliation reveals the new path.

## Watcher behavior

Use:

```ts
watch(root, { recursive: true })
```

for local directories on both platforms. The callback is only a scheduling signal. `filename` is treated as optional because Node does not guarantee it on every event.

`fs.watch` is cross-platform and is not behind the platform seam. The one semantic question that
had to be answered by a kernel rather than by documentation — whether Node 24's `recursive: true`
on Linux delivers events for directories created *after* the watch was opened — is answered: on the
Linux job the daemon scenario suite still notices a linked worktree created outside the workspace
root, which it can only see through the `worktrees/` directory `git` adds under the repository's
administrative root while the watch is already open, and it notices it inside the same budget it
allows on macOS. No per-directory fallback walk was needed. Finer differences
(what an inotify-backed watcher coalesces, what it reports for a directory replaced rather than
modified) are still not enumerated here, and deliberately do not matter: the reconciliation below
is designed not to depend on any individual event arriving, which is what keeps a watcher
difference from being a correctness difference.

The watcher layer debounces/coalesces bursts and schedules a bounded reconciliation rather than acting directly on every filesystem event.

Recommended defaults:

```text
debounce: 200 ms
max coalesce window: 1000 ms
```

## Source edits are ignored

WTM should not inspect every source-file change. Reconciliation uses structural watch interests such as Git metadata and configuration/lock/manifest files.

When the OS callback does not identify the changed path, WTM runs a lightweight repository topology/config fingerprint comparison instead of scanning build directories.

## Startup recovery

On daemon startup:

1. open/migrate state DB;
2. load registered workspaces;
3. set aside the registered roots that are not on disk, reporting each one;
4. verify managed process identities;
5. verify endpoint leases;
6. schedule pending cleanup retries;
7. **open the platform IPC endpoint**;
8. run Git worktree snapshot for known repos;
9. reconcile missing/new worktrees;
10. start filesystem watchers.

No previous in-memory state is required for recovery.

Two properties of that order are deliberate, and both were learned from a daemon that would not start:

- **A registered root that has gone is not fatal.** A finished migration deleted, a volume unmounted, a clone moved — refusing to start over one of them denied every other workspace a daemon, and because launchd restarts a service that exits non-zero, one deleted directory became a permanent restart loop whose only trace was a line in a log nobody is pointed at. The registration is kept, because the directory may come back; it is left out of this pass and reported. `wtm doctor` names it.
- **A repository that overran its bound is read again, alone, before it is believed.** Eight concurrent reads off a volume that is still spinning up can each overrun a bound every one of them clears a moment later; believing the first reading discards the whole pass and leaves every registered repository stale. The overrun repositories are retried one at a time under a wider bound, which removes contention as an explanation before the failure is acted on.
- **When not one repository can be read, that is one condition, not N — and the condition is read, not guessed.** The log filled with one identical timeout per repository, naming neither the repository nor the cause, while `wtm daemon status` reported the daemon as running and reachable, which it was. A pass that reads nothing now reports one line, and that line is based on opening the directories directly: a refusal (`EACCES`) names the privacy grant, while directories that open normally name a filesystem answering too slowly, which is the far commoner cause and needs no grant at all. Every git failure names its subcommand and its repository.
- **Every line in the daemon log is stamped, and a recurring condition is counted rather than repeated.** Without the stamps there is no way to tell a burst at startup from a failure happening now — the question the log exists to answer. Collapsing only *consecutive* repeats collapsed nothing, because a pass reports each of its repositories in turn: six permanently missing directories wrote a quarter of a megabyte. A condition is written at most once per ten minutes, carrying the number of times it recurred in between.
- **The socket opens before the first reconcile.** Reading every registered repository is the slowest thing the daemon does — one `git` per repository, each with its own timeout — and a machine with a few dozen of them spent minutes there while every command failed as `WTM_DAEMON_UNAVAILABLE`. Answering from the last known topology is worse than answering from a fresh one, and far better than not answering.

## Preparation and lifecycle events

Each reconcile that changes a repository's topology also decides what has to happen because of it, in one order:

1. announce `workspace.discovered` and `repo.discovered`, each once per subject, ever;
2. for each newly discovered worktree, announce `worktree.discovered` (first reconcile of that repository) or `worktree.created` (any later one);
3. under `[prepare] mode = "eager"`, create that worktree's declared resources and announce `worktree.ready`;
4. for each orphaned worktree, announce `worktree.removed` in the repository's main worktree, which is the only directory still there to run in.

Under the default `lazy` mode, step 3 happens instead at the first `run`, `start` or `exec` in that worktree, and `worktree.ready` is announced there. `runtime.started` and `runtime.stopped` are announced by the runtime controller, after the supervisor has actually started or stopped something.

Three rules keep an event from becoming a way for the daemon to hurt itself:

- **Once-only events are recorded in the state database.** Deciding from memory would announce them again after every restart, which for an event bound to `deps.install` means installing dependencies again on every reboot.
- **A task an event starts dispatches no events.** It goes straight to the supervisor, so `[events."runtime.started"]` cannot set itself off.
- **An event never fails what raised it.** A task that will not start is reported through `onError` and the reconcile continues, because one workspace's event must not deny every other workspace a daemon.
- **A dispatch that could not happen withdraws its announcement.** The claim is taken before the work, so two passes cannot run one event twice; if the configuration will not resolve or a resource cannot be created, the claim is given back and the next pass tries again. A claim is kept once the event has actually run, whatever became of its tasks.

## Sleep/wake and missed events

WTM does not depend on an event being delivered exactly once. Any subsequent `status`, `doctor`, `analyze`, `plan`, daemon restart or structural event can reconcile state from Git.

V1 does not add high-frequency polling merely to detect sleep/wake. If field testing shows reliable wake detection is needed, add a narrow macOS helper behind the watcher interface rather than spreading native code through core packages.

## IPC transport

Windows uses a named pipe whose name is derived from the data root. It does not publish a
filesystem socket or use POSIX mode `0600` as an access-control guarantee. The Windows publisher
uses Node's named-pipe transport; native cross-account access isolation remains to be verified.
Pipe naming alone is not authentication.

### macOS and Linux Unix domain socket

The socket is `wtmd.sock` inside the platform's socket directory:

```text
macOS   ~/Library/Application Support/WTM/wtmd.sock
Linux   $XDG_RUNTIME_DIR/wtm/wtmd.sock, or <data root>/wtmd.sock when that variable is unset
```

The socket is user-only (`0600`). Requests and responses use framed JSON with a protocol version.

V1 framing is deterministic: a four-byte unsigned big-endian payload length followed by exactly that many UTF-8 JSON bytes. The default payload ceiling is 1 MiB and is checked from the header before allocating the frame body or parsing JSON. Receivers accept fragmented headers/bodies and multiple coalesced frames.

No HTTP server and no local TCP port are required.

### How long the address may be

A Unix socket address is a fixed-size buffer in the kernel, and the two platforms size it
differently:

| Platform | `sizeof(sun_path)` | How that number was established |
| --- | --- | --- |
| macOS | 104 bytes | **Measured.** Paths of every length from 96 to 112 bytes were bound on macOS 15 / Node 24: 104 listens, 105 raises `EINVAL`, and `connect()` draws the line in the same place. |
| Linux | 108 bytes | **Measured.** The value in `linux/un.h`, and now also an experiment: on the Linux CI job a Node child sweeps every address length from 96 to 128 bytes and asserts that 108 listens, 109 raises `EINVAL`, and `connect()` draws the same line. |

What the Linux measurement buys is notice rather than universality. It is measured on the kernel
and glibc `ubuntu-latest` x64 was running under Node 24 the last time the job ran — not on musl, not
on arm64, and not on whatever a given user has. A kernel or libc that moved the boundary would
otherwise surface as a daemon refusing a path it could have bound, or accepting one it cannot; with
the measurement in the suite it surfaces as a red build naming the constant.

Both numbers flow through the same preflight. `wtm daemon serve`, `wtm daemon install` and the
CLI's connect side measure the address in bytes before binding or dialling, and refuse with
`WTM_SOCKET_PATH_TOO_LONG` naming the measured length, the limit *in force on this platform*, and
how much shorter the home directory would have to be. `wtm doctor`'s `socket-path` check reports
the headroom while there still is some.

The measurement exists as a measurement, rather than as a rescued `EINVAL`, because the failure
does not reproduce in the environment WTM is developed in: Bun's own limit is 118 bytes, so
`bun test` and `bun run` happily bind a path the shipped Node executable cannot. The published path
and the private path actually bound are both measured, and the longer of the two decides.

On Linux the limit is much less likely to bite in practice, because `$XDG_RUNTIME_DIR` is normally
`/run/user/<uid>` — around 15 bytes, against a home directory of any depth. That is a consequence
of putting the socket where the platform says sockets go, not a separate mitigation.

## Process identity

WTM stores a `(pid, start time)` pair for every process it supervises and every holder of a
destructive-operation lease, and compares it against the live process before acting. The pair is
what makes a recycled PID detectable: the number alone would let a lease be reclaimed from a
different process that happens to have inherited it.

The start time is read differently on each platform, and the questions it answers are not the
same question:

- **macOS** shells out to `ps -ww -p <pid> -o lstart=` and stores what it prints —
  `Mon Sep  1 12:00:00 2026`.
- **Linux** reads `/proc/<pid>/stat` and stores `<btime>:<starttime>`: the wall-clock second the
  kernel booted, from `/proc/stat`'s `btime` line, and the process's start time in clock ticks
  since that boot. Boot time alone is not enough — start ticks repeat after every reboot, so PID
  412 started at tick 2778072 of this boot and PID 412 started at tick 2778072 of the last one
  would be indistinguishable without it.
- **Windows** reads CIM `Win32_Process` creation time and compares a command fingerprint.
  Parent/child tree membership is checked against creation times before taskkill-based cleanup.
  This is not a POSIX process group or a Windows Job Object containment guarantee.

**The macOS and Linux formats can never be equal**, because the Linux string is decimal digits and a colon
while the macOS string contains letters and spaces. That is deliberate, and it is why the two
coexist in one state column with no version tag and no migration.

Two Linux details are worth stating because they are how naive `/proc` readers break:

- `/proc/<pid>/stat`'s second field is the command name, wrapped in parentheses by the kernel and
  escaped in no way at all — it may contain spaces and further parentheses. Every later field is
  located relative to the **last** `)` in the line, never by splitting on whitespace. A parser that
  splits reads a fault count as a process group and a page count as a start time, both silently
  plausible numbers. The fixtures this is tested against are genuine kernel output, captured from a
  Debian container by copying `/bin/sleep` to deliberately awful names, rather than hand-written by
  the same understanding that wrote the parser.
- **Absence means one thing and one thing only: the `/proc` entry is gone.** A read error, a
  permission error, an unparseable line, a `/proc/stat` with no `btime` — every one of those is a
  *failure*, reported as such, never as absence. A wrong absence releases a lease somebody else is
  holding, and the operations behind those leases delete worktrees.

A zombie is treated per question rather than per platform, and macOS's existing behaviour is the
reason. The two supervision readers ask for a state column and drop zombies; the lease reader asks
`ps` for `lstart` alone, has no state column, and therefore reports a zombie lease holder as
present. Linux matches that exactly. Making Linux stricter would mean a lease macOS holds and Linux
reclaims — a wrong absence — in exchange for releasing a lease a few milliseconds before the parent
reaps the child. Whether a zombie lease holder *should* be reclaimable is a real question; it
belongs with lease semantics, not with the platform seam.

`process-anchor.ts` reads platform-specific identity. Its code lives inside a program serialised
into a string and executed by a separate `node`, so it cannot import a platform port and the
readers are inlined there. The anchor is **told** which platform to speak, through its spec, and
does not read `process.platform`: the dialect is a property of the decision the supervisor already
made, and an anchor that observed its own could disagree with the port reading it — a disagreement
that would surface as `ANCHOR_IDENTITY_MISMATCH`, blaming the process for changing identity when
in fact the two sides were speaking different languages. The duplication is held to the port by a
live test that compares the anchor's reading against `@wtm/platform`'s on whichever platform the
suite is executing on, so drift is a red build rather than a silent divergence.

## Daemon unavailable

Read-only commands such as:

```text
status
doctor
analyze
plan
```

may run an in-process local reconciliation if the socket cannot be reached. Managed process operations require the daemon.

This prevents the failure mode where WTM cannot diagnose WTM because the daemon is down.

## Logs

WTM logs live under:

```text
macOS   ~/Library/Logs/WTM/
Linux   <data root>/logs/, i.e. ~/.local/state/wtm/logs by default
Windows <data root>\logs\
```

Logs follow the data root on Linux rather than `$XDG_CACHE_HOME`: they are the daemon's record of
what it did, which a user expects to survive a cache clear.

Managed task stdout/stderr is redirected directly to files, not accumulated in RAM.

Default rotation target:

```text
20 MiB per file
3 retained files
```

Runtime log-store overrides accept 1–32 retained archives per stream; larger counts are rejected
before startup. The shared bound keeps both streams and their rotation evidence within a bounded
operation. Finite queued jobs use their separate 1 MiB / one-archive policy. On Windows, the anchor
checks SID/DACL evidence for directories, existing files and newly opened empty files before
writing trusted bytes. ACL inspection is asynchronous, operation-local and bounded; ordinary log
chunks do not start PowerShell. Failed or aborted helper processes retain their local inspection
slot until process closure is observed. Native Windows acceptance remains experimental.


## Resource budget

V1 acceptance target on a representative Apple Silicon Mac:

```text
idle CPU p95:      < 0.2%
idle RSS target:   < 85 MiB
idle RSS review:   > 110 MiB triggers profiling before release
source edit storm: no adapter process spawned for ordinary source edits
registered but idle worktrees: no dev runtime process
```

If the watcher/supervisor layer cannot meet the budget after TypeScript/Node profiling and ordinary optimization, a Rust helper may be introduced behind one narrow interface. Rust is not a default architectural dependency.

The RSS numbers above were revised 2026-09-06 (todo item 42) after measurement showed the original
60/80 MiB pair was set below what a bare Node.js process on this project's pinned runtime already
costs: a real breakdown found ~46 MiB of that RSS present before any WTM code runs, and another
~27 MiB from loading the bundled daemon and `better-sqlite3`'s native binding — WTM's own
construction and startup (state store, supervisor, log store, Unix socket server, structural
watcher) added only ~6 MiB on top. Those historical macOS measurements fit inside 85/110 MiB
with headroom for a regression to trip the gate. They do not establish a Windows baseline,
current-revision performance or RAM savings across the user's concurrent AI sessions.

## Node single executable note

Standalone Node SEA builds are implemented and the macOS `v0.1.0-rc.1` release contains arm64
and x64 archives with checksums. The builder and native binary gate require exactly Node
24.18.0. Ordinary JavaScript execution remains available from a source build.
There is no verified published Homebrew channel, Linux release archive or Windows installer;
rendered formulas and a configured CI build are not distribution evidence. npm package
construction is implemented, but registry publication is a separate release milestone.
