# WTM — Worktree Runtime Manager

Status: **Implemented and pre-release — no published artifact or release tag yet**  
Primary platform: **macOS**  
Primary implementation language: **TypeScript**  
Runtime baseline: **Node.js 24 LTS**  
Development tooling: **Bun 1.3+**
Project model: **open-source, local-first, AI-first**

WTM solves the operational problems that appear when developers and AI coding agents use many Git worktrees at the same time:

- environment variables collide;
- dev-server ports collide;
- workspace-level Makefiles/tasks cannot be discovered from nested worktrees;
- runtimes, containers and databases become difficult to attribute to one worktree;
- dependency/build directories are duplicated unnecessarily;
- agents repeatedly need to rediscover how to start, test and diagnose a project;
- stale worktrees are hard to evaluate safely;
- deleting a worktree can destroy uncommitted or unpushed work.

WTM is not a replacement for Git, Make, Bun, npm, pnpm, uv, Cargo, Go, Gradle, Docker or language-specific tooling. It is a **context-aware orchestration layer** around them.

## Core principles

1. **One-time setup.** `wtm init` scans an existing workspace, repositories and worktrees and creates a usable configuration.
2. **Local by default.** WTM only watches initialized workspaces. `--global` aggregates registered workspaces when explicitly requested.
3. **AI-first.** Important commands have stable `--json` output and the project ships an Agent Skill in `skills/wtm/SKILL.md`.
4. **No manual port selection.** Worktree runtime endpoints are allocated and persisted by WTM.
5. **No manual `.env` copying.** Shared configuration and generated runtime environment are separate concepts.
6. **Native cache first.** WTM uses package-manager/compiler caches instead of inventing another dependency cache.
7. **Mutable outputs stay isolated.** `.next`, `target`, `build`, `dist`, `.venv` and similar branch-dependent outputs are never blindly shared writable directories.
8. **No forced deletion.** WTM refuses to remove a worktree with dirty/untracked changes or commits that have not been safely persisted to a remote.
9. **No Git-hook ownership.** Worktree discovery is event-driven and reconciled against Git's own machine-readable worktree state.
10. **Minimal idle cost.** No source-tree polling loop; adapters do not remain resident; only the daemon watcher/state layer stays alive.

## Design decisions at a glance

- TypeScript first; Rust only after profiling proves a native helper is necessary.
- Node 24 LTS is the runtime baseline for V1.
- Bun 1.3+ manages the development workspace, dependencies, scripts and tests.
- macOS directory watching uses Node's native `fs.watch`, which maps directory watches to FSEvents.
- `git worktree list --porcelain -z` is the source of truth for worktree topology.
- SQLite stores persistent identities, resource ownership, port assignments and process metadata.
- CLI and daemon communicate over a Unix domain socket.
- External adapters use a versioned JSON stdin/stdout protocol and exit after each request.
- Worktree creation prepares metadata/resources but does not automatically start heavy development runtimes.
- Dependency materialization is lazy by default.
- `wtm remove` has no loss-bypassing `--force` mode in V1.

## Document index

1. `01-product-goals-and-non-goals.md` — product definition and boundaries.
2. `02-architecture.md` — system architecture and component responsibilities.
3. `03-configuration-spec.md` — TOML schema, inheritance and templating.
4. `04-cli-reference.md` — commands and local/global semantics.
5. `05-daemon-and-macos-runtime.md` — launchd, filesystem watching, IPC and recovery.
6. `06-adapter-protocol.md` — language/framework-independent adapter architecture.
7. `07-process-port-runtime.md` — port leases, process groups and runtime ownership.
8. `08-storage-cache-gc.md` — dependency storage, APFS strategies and GC.
9. `09-init-scope-discovery.md` — `wtm init`, repository discovery and scope registration.
10. `10-git-safety-worktree-analysis.md` — advanced analysis and safe deletion rules.
11. `11-ai-first-skill-integration.md` — AI workflows and skill installation model.
12. `12-open-source-distribution.md` — licensing, packaging, governance and release strategy.
13. `13-data-model-and-state-machines.md` — SQLite model and lifecycle states.
14. `14-testing-performance-security.md` — test matrix, performance budgets and security model.
15. `15-roadmap.md` — staged delivery scope.
16. `16-implementation-plan.md` — TDD-oriented implementation plan.
17. `17-reference-configs.md` — practical configuration examples.
18. `18-errors-json-contract.md` — machine-readable output and stable error model.
19. `99-references.md` — official references used while designing WTM.
20. `adr/` — architecture decision records.

## Recommended first milestone

The first usable release should support:

- `wtm init` / `wtm init --global`;
- automatic repository/worktree discovery;
- stable worktree IDs;
- `wtm status`, `wtm doctor`, `wtm explain`, `wtm analyze`;
- TOML task resolution including `main` vs `worktree` commands;
- stable-dynamic ports;
- `wtm run`, `wtm start`, `wtm stop`, `wtm logs`;
- safe `wtm remove` preflight;
- Bun/pnpm/npm, uv, Cargo, Go, Make and Docker Compose built-in detection;
- the Agent Skill;
- launchd installation.

Everything else can evolve without breaking this foundation.
