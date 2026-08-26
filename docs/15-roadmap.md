# Roadmap

## Phase 0 — Repository and contracts

Deliver:

- open-source repository scaffolding;
- TypeScript/Bun workspace;
- protocol/config schemas;
- temp Git testkit;
- CI on macOS;
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

- launchd install/uninstall;
- `fs.watch`/FSEvents registry;
- Unix socket;
- event -> reconciliation;
- startup recovery;
- managed background process groups;
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
- Homebrew distribution;
- npm distribution;
- upgrade/migration tests;
- contribution/security docs;
- semver/protocol compatibility policy.

## Deferred until evidence demands it

- Rust helper;
- local reverse proxy/domain routing;
- Linux support;
- PR/GitHub API awareness;
- automatic idle-runtime suspension;
- resource budget enforcement;
- standalone Node SEA as primary distribution;
- GUI/menu bar application.

The architecture supports these, but V1 should not carry their maintenance cost.
