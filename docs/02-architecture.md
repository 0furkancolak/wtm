# Architecture

## High-level model

```text
              macOS │ Linux   (one PlatformRuntime, selected at startup)
                              │
             launchd │ systemd --user
                              │
                             wtmd
                              │
             ┌────────────────┼─────────────────┐
             │                │                 │
          fs.watch           Git             SQLite
      (FSEvents/inotify)  porcelain state      state
             │                │                 │
             └────────────────┼─────────────────┘
                              │
                         Reconciler
                              │
                        Context Resolver
                              │
                       Configuration Graph
                              │
                         Adapter Graph
                              │
                         Resource Plan
                              │
                  ┌───────────┼────────────┐
                  │           │            │
                env        endpoints     storage
                  │           │            │
               tasks       processes    runtime
                  └───────────┼────────────┘
                              │
                          Core Apply
                              │
                            State

      wtm CLI  ───────── Unix domain socket ───────── wtmd
```

## Packages

The source repository should use a small Bun workspace with explicit package boundaries. Runtime packages remain compatible with Node.js 24 LTS; Bun is the development package manager, script runner and test runner.

```text
packages/
├── protocol/        # shared types, JSON schemas, error codes
├── core/            # config, Git model, planning, analysis, ownership
├── adapters/        # built-in adapter implementations
├── daemon/          # watcher, IPC server, service lifecycle, supervisor
├── cli/             # command parsing and human/JSON presentation
└── testkit/         # temporary Git repositories and fixture helpers

skills/
└── wtm/
    └── SKILL.md
```

The packages are separate because external adapter authors and agent integrations need stable contracts while daemon internals should remain replaceable.

## Core responsibilities

The core owns:

- workspace registration and scope;
- config inheritance and provenance;
- Git repository/worktree topology;
- stable identity allocation;
- worktree analysis;
- plan normalization;
- conflict detection;
- resource ownership;
- endpoint leases;
- task resolution;
- safe deletion policy;
- state transitions.

Core modules do not directly perform UI rendering and are not coupled to any one operating system: everything platform-specific lives behind `@wtm/platform`, and a structural test fails if a platform-specific import, literal or spawned command re-enters `core` or `protocol`.

## Daemon responsibilities

The daemon owns:

- event-driven filesystem watching;
- scheduling reconciliations;
- the Unix socket server;
- persistent managed-process supervision;
- log redirection/rotation;
- service installation state (launchd or the systemd user manager);
- background cleanup retries.

The daemon never interprets a framework-specific lockfile itself; it calls the core/adapter layer.

## Shared finite-task queue

`wtm run <task> --enqueue` sends a configured finite task to the existing daemon. SQLite commits
the job before the CLI receives its identifier. A transaction claims the FIFO head and its
concurrency slot together; the default is one heavy task across every registered repository in
this state database. Jobs in the same worktree never hold slots together. A blocked FIFO head
deliberately holds back later jobs. Ordinary foreground `run` and background `start` retain
their separate execution paths.

The queue uses the existing process anchor, managed-process store and log safety rules. The
job is bound to its process before the anchor receives GO. Numeric completion evidence is
written by the anchor, including timeout information when the daemon is unavailable. Recovery
never retries a command with an uncertain outcome. A job keeps its slot until the complete
process group is confirmed absent; neither a STOPPED label nor a cancellation request alone
proves that condition. Destructive repository leases and queued/running jobs exclude one
another in the same database transaction.

Queue state binds to a machine/user identity before managed process recovery. Subsequent use
of that database by another host or user is rejected; machines with a shared HOME must use
separate, host-local state. Legacy unscoped process records are adopted once under the existing
host-local-state assumption; migration cannot establish which host originally created them.
Cloned operating system images must have distinct machine identities. The queue scope is an
application-specific HMAC of these inputs; raw machine/user identifiers are not published:

| Platform | Machine identity | User identity | Reference |
| --- | --- | --- | --- |
| Linux | machine-id | UID | [systemd machine-id](https://www.freedesktop.org/software/systemd/man/249/machine-id.html) |
| macOS | IOPlatformUUID | UID | [Apple platform UUID key](https://developer.apple.com/documentation/iokit/kioplatformuuidkey) |
| Windows | SMBIOS system UUID | SID | [Microsoft system product UUID](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystemproduct) |

This remains a cooperative scheduling limit, not a memory quota. Distinct state directories,
direct terminal commands and a task's internal workers operate outside the shared slot count.
No periodic host memory scanner is added. The queue wakes for admission/completion and checks
outstanding jobs at bounded intervals; an empty queue has no recurring scheduler timer.

Source evidence covers HEAD, index and Git-visible tracked/untracked content, including file
identity/time metadata. It is checked before launch, on completion and on result lookup. It
does not freeze sources or measure ignored/external dependencies. File, byte and elapsed-time
budgets fail closed; symlinks/submodules are refused. See the
[measurement procedure](development/2026-09-09-heavy-job-memory-measurement.md) for the separate
native two-session RAM experiment still required before claiming a saving.

## CLI responsibilities

The CLI is a thin client. For commands requiring daemon state it connects to the Unix socket. If the daemon is unavailable, read-only diagnostic commands may run a local reconciliation.

The CLI owns:

- argument parsing;
- local-vs-global selector resolution;
- TTY formatting;
- `--json` serialization;
- exit codes;
- interactive confirmation only where explicitly designed.

Business rules must not be duplicated in CLI command handlers.

## Reconciliation model

Filesystem events are hints, not truth.

For worktree topology the authoritative query is:

```bash
git -C <repo> worktree list --porcelain -z
```

WTM compares the new snapshot with persisted state and produces transitions:

```text
known + present       -> update
unknown + present     -> discovered/created
known + absent        -> orphaned -> cleanup
```

This handles:

- worktrees created through raw Git;
- worktrees created through Codex/Claude/another application;
- daemon restarts;
- events that are coalesced;
- worktrees moved or repaired.

## Event filtering

A watched workspace can contain millions of source edits. WTM must not invoke adapter discovery for arbitrary source changes.

Structural triggers include:

- Git administrative changes;
- `wtm.toml` / `.wtm.toml`;
- recognized ecosystem marker/lock files;
- Makefile/task configuration files;
- Compose files.

Normal `src/**` edits are ignored by the orchestration layer.

## Adapter architecture

Adapters can be built in or external. They all produce declarative metadata and plans. External adapters are short-lived executables using JSON over stdin/stdout.

```text
metadata -> detect -> plan -> core apply
                         \
                          -> doctor
cleanup-plan -> core apply
```

The adapter proposes. Configuration and core safety rules decide.

## Runtime ownership

Every runtime resource belongs to an owner:

```text
worktree:<persistent-id>
```

Owned resources can include:

- endpoint/port leases;
- managed process groups;
- Docker project namespace;
- temporary files;
- generated runtime env;
- logs;
- cleanup actions.

This ownership is the key to deterministic cleanup.

## Why TypeScript first

Node's native filesystem watcher uses FSEvents for directory watches on macOS and inotify on Linux, so the V1 watcher can be implemented without a Rust/Swift helper on either. TypeScript also lowers contribution cost and keeps protocol/CLI types shared.

Rust is intentionally reserved for a measured performance problem, not used preemptively. A native helper can later replace a narrow interface such as watcher/process inspection without changing the core contract.

## Failure containment

- external adapter crash: adapter call fails; daemon remains alive;
- malformed adapter JSON: rejected by protocol schema;
- Git command failure: repository becomes degraded, other repositories continue;
- daemon crash: the service manager restarts it — launchd's `KeepAlive`, systemd's `Restart=on-failure` — and startup reconciliation repairs state;
- stale process record: identity verification prevents killing unrelated PIDs;
- unavailable Docker: cleanup remains pending and retries later;
- invalid config: affected workspace is degraded; other registered workspaces remain operational.
