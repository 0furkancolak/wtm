# Roadmap

## Current implementation and remaining evidence

The phases below describe the delivery sequence, not a checklist of completed releases.
[todo.md](../todo.md) tracks acceptance criteria and outstanding work.

The source now includes macOS, Linux and experimental Windows platform backends, a durable
finite-task queue, configurable shared concurrency and optional estimated-memory admission.
The queue covers status, logs, results, cancellation, timeout, restart reconciliation and
bounded source evidence. HTTP readiness observation and reclaimable-byte estimates are also
implemented. These features need native evidence for each claimed platform; fixture coverage
and a configured CI job alone do not close that requirement.

Published standalone assets remain the macOS arm64/x64 `v0.1.0-rc.1` prerelease archives.
Linux and Windows release archives, a verified Homebrew channel, Windows package managers and
the remaining native service/cleanup acceptance are separate delivery work. See
[SUPPORT.md](../SUPPORT.md) for the current platform boundaries.

## Phase 0 — Repository and contracts

Deliver:

- open-source repository scaffolding;
- TypeScript/Bun workspace;
- protocol/config schemas;
- temp Git testkit;
- CI, now configured for macOS arm64/x64, Linux x64 and Windows x64;
- docs/ADRs/skill included.

No daemon yet.

## Phase 1 — Local core and `wtm init`

Deliver:

- local/global workspace registration;
- repository discovery;
- Git worktree porcelain parser;
- current-worktree context resolver;
- TOML config inheritance/provenance;
- stable IDs;
- `wtm init`, `status`, `doctor`, `explain`;
- built-in Make/task resolution.

This phase already solves the parent-workspace Makefile problem.

## Phase 2 — Advanced analysis and safe removal

Deliver:

- dirty/untracked/unmerged analysis;
- upstream/ahead/behind analysis;
- remote-persisted HEAD analysis;
- base/merged analysis;
- `wtm analyze`;
- deletion readiness codes;
- safe `wtm remove` without force bypass.

This phase must be complete before advertising automated cleanup.

## Phase 3 — Runtime endpoints and tasks

Deliver:

- stable-dynamic ports;
- environment/template resolution;
- `wtm resolve`, `run`, `env`;
- capability dependencies;
- built-in Bun/pnpm/npm/uv/Cargo/Go detection.

## Phase 4 — Daemon and managed processes

Deliver:

- platform service install/uninstall: launchd, systemd user manager, experimental Scheduled Tasks;
- `fs.watch` structural registry;
- Unix socket or Windows named-pipe transport;
- event -> reconciliation;
- startup recovery;
- managed background process groups/trees with identity checks;
- `start`, `stop`, `ps`, `logs`.

## Phase 5 — Resource/storage lifecycle

Deliver:

- resource graph;
- native-cache policies;
- symlink/copy/isolated policies;
- APFS clone helper in TypeScript/OS commands where reliable;
- `disk`;
- safe GC/dry run;
- Docker Compose namespace adapter and cleanup ownership.

## Phase 6 — External adapters and skill installer

Deliver:

- adapter JSON protocol process bridge;
- trust/hash registry;
- adapter SDK/test harness;
- `wtm adapter list/trust`;
- Agent Skill installer;
- agent-oriented docs/examples.

## Phase 7 — Public release hardening

Deliver:

- performance benchmarks;
- security review of cleanup/task execution;
- standalone Node SEA distribution;
- Homebrew distribution;
- npm distribution;
- upgrade/migration tests;
- contribution/security docs;
- semver/protocol compatibility policy.

## Deferred until evidence demands it

- Rust helper;
- local reverse proxy/domain routing;
- PR/GitHub API awareness;
- automatic idle-runtime suspension;
- operating-system-enforced resource limits beyond the implemented estimated-memory admission;
- GUI/menu bar application.

The architecture supports these, but V1 should not carry their maintenance cost.

## Cross-platform and queue follow-up

- Complete native Windows process cleanup, trust, IPC and service-recovery evidence before
  promoting the experimental backend to supported distribution.
- Exercise the full Linux systemd user-service lifecycle in a real user session; add Linux
  arm64 and musl acceptance only when their toolchain and native results are available.
- Define and verify Linux/Windows release artifacts and upgrade/uninstall paths before
  publishing installation commands for those channels.
- Run the documented two-session RAM experiment on the user's host; concurrency and declared
  estimates do not demonstrate measured RAM savings or a strict memory ceiling.
- Add agent notification/hook integration only after the target agent's capabilities have
  been verified. The current skill submits work, continues independent work and checks results.
