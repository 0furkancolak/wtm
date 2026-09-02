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
