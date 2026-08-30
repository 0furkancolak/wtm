# Daemon and macOS Runtime

## Implementation choice

V1 uses TypeScript on Node.js 24 LTS.

Node's native `fs.watch()` maps directory watches to FSEvents on macOS, so a separate Rust/Swift watcher is not justified before profiling.

## Process model

```text
launchd
  └── wtmd
       ├── workspace watcher registry
       ├── reconciliation queue
       ├── SQLite state store
       ├── Unix socket server
       └── managed process supervisor
```

External adapters are not resident processes.

## LaunchAgent

`wtm daemon install` installs a per-user LaunchAgent under:

```text
~/Library/LaunchAgents/dev.wtm.daemon.plist
```

The exact label can change before public release if the final reverse-DNS project identifier changes.

The LaunchAgent invokes the resolved `wtmd` binary/script and restarts it on unexpected failure. Installation never requires root.

`ProcessType` is `Adaptive`, not `Background`. launchd throttles a Background job's CPU and disk I/O, and everything it spawns inherits the throttle — the port prober is one short-lived process per candidate port, and under the throttle it outlived its own two-second timeout, so every port read as taken; the developer's own dev server ran throttled too. Nothing this daemon does is unattended work.

`wtm daemon install` waits for the daemon to answer on its socket before it reports success, and both `install` and `status` report `reachable`. launchd reports a service as running the moment it forks, which said nothing about whether a command would work.

`wtm daemon install` restarts a service that is already loaded. The plist names the executable by path, so installing a new build leaves the definition byte-identical and launchd goes on running the previous binary — an install that reported success and changed nothing, and made verifying a new build impossible. Restarting in place is the cheapest guarantee that the daemon now answering is the one just installed; the state it needs is all in SQLite, and startup recovery is designed for exactly this.

macOS may withhold disk access from a background agent. The executable is signed under one stable identifier (`dev.wtm.cli`) so the grant is not invalidated by every rebuild — but WTM asks for nothing up front, and names the grant only on evidence: a registered directory that exists and refuses to open. A timeout is not that evidence. A `git` that overran its bound on a volume answering slowly is indistinguishable from a denied one until the directory is opened directly, and telling somebody to hand a background agent every file on their disk on the strength of a timeout is advice too large to give on a guess.

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

for local macOS directories. The callback is only a scheduling signal. `filename` is treated as optional because Node does not guarantee it on every event.

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
7. **open the Unix socket**;
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

## Unix domain socket

Suggested location:

```text
~/Library/Application Support/WTM/wtmd.sock
```

The socket is user-only (`0600`). Requests and responses use framed JSON with a protocol version.

V1 framing is deterministic: a four-byte unsigned big-endian payload length followed by exactly that many UTF-8 JSON bytes. The default payload ceiling is 1 MiB and is checked from the header before allocating the frame body or parsing JSON. Receivers accept fragmented headers/bodies and multiple coalesced frames.

No HTTP server and no local TCP port are required.

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
~/Library/Logs/WTM/
```

Managed task stdout/stderr is redirected directly to files, not accumulated in RAM.

Default rotation target:

```text
20 MiB per file
3 retained files
```

## Resource budget

V1 acceptance target on a representative Apple Silicon Mac:

```text
idle CPU p95:      < 0.2%
idle RSS target:   < 60 MiB
idle RSS review:   > 80 MiB triggers profiling before release
source edit storm: no adapter process spawned for ordinary source edits
registered but idle worktrees: no dev runtime process
```

If the watcher/supervisor layer cannot meet the budget after TypeScript/Node profiling and ordinary optimization, a Rust helper may be introduced behind one narrow interface. Rust is not a default architectural dependency.

## Node single executable note

Node supports single-executable applications, but the feature remains in active development. Therefore V1 distribution should not depend on SEA for correctness. Homebrew/npm installs are primary; standalone SEA binaries may be an additional release artifact later.
