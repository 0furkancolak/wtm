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
3. validate workspace roots;
4. run Git worktree snapshot for known repos;
5. reconcile missing/new worktrees;
6. verify managed process identities;
7. verify endpoint leases;
8. schedule pending cleanup retries;
9. start filesystem watchers;
10. open the Unix socket.

No previous in-memory state is required for recovery.

## Sleep/wake and missed events

WTM does not depend on an event being delivered exactly once. Any subsequent `status`, `doctor`, `analyze`, explicit `reconcile`, daemon restart or structural event can reconcile state from Git.

V1 does not add high-frequency polling merely to detect sleep/wake. If field testing shows reliable wake detection is needed, add a narrow macOS helper behind the watcher interface rather than spreading native code through core packages.

## Unix domain socket

Suggested location:

```text
~/Library/Application Support/WTM/wtmd.sock
```

The socket is user-only (`0600`). Requests and responses use framed JSON with a protocol version.

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
