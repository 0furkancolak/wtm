# Product Goals and Non-Goals

## Problem statement

Parallel Git worktrees are easy to create but expensive to operate. A single repository that normally assumes one development runtime suddenly has multiple independent checkouts competing for the same ports, runtime names, databases and generated directories. AI agents make this more common because they can create several worktrees concurrently and often lack persistent knowledge of workspace-level conventions.

WTM creates a durable runtime identity around each worktree and exposes the same operations to humans and agents.

## Product goals

### G1 — One-time initialization

A developer installs WTM and runs:

```bash
wtm init
```

WTM scans the selected workspace, detects repositories, discovers existing linked worktrees, identifies ecosystem markers, finds workspace-level task runners such as Makefiles, proposes a configuration, registers the workspace and starts monitoring it.

Repeated setup for every worktree is not acceptable.

### G2 — Universal ecosystem support

WTM must not be architected around TypeScript projects. The core understands generic concepts:

- repositories and worktrees;
- resources;
- caches and outputs;
- environment;
- runtime endpoints;
- tasks;
- processes;
- lifecycle and ownership.

Language/framework knowledge lives in adapters.

### G3 — AI-native ergonomics

AI agents should be able to operate a WTM workspace with a very small command vocabulary:

```bash
wtm doctor --json
wtm status --json
wtm run <task>
wtm start <task>
wtm analyze --json
```

Agents must not need to select ports, copy env files, discover a parent Makefile or guess which runtime belongs to which worktree.

### G4 — Safe worktree lifecycle

WTM may make creation and operation convenient, but deletion must be conservative. A worktree cannot be removed while it contains:

- staged changes;
- unstaged tracked changes;
- untracked files;
- unmerged paths;
- commits that are not safely represented by an allowed remote ref.

WTM explains how to resolve the blocker. It does not automatically commit, push, reset, clean or discard source code.

### G5 — Low idle overhead

WTM should not become the heaviest process in an otherwise idle development machine. The daemon must use event-driven filesystem notifications and must not keep language adapters alive.

Performance budgets are defined in `14-testing-performance-security.md`.

### G6 — Efficient storage

WTM avoids unnecessary duplication without weakening isolation:

- native package/compiler caches are reused;
- branch-dependent writable outputs remain isolated;
- APFS cloning is available for explicitly cloneable resources;
- heavy materialization is lazy by default;
- GC only deletes resources that are owned and classified as safe to remove.

### G7 — Open-source friendly

The project has no required cloud account, no default telemetry and no proprietary runtime dependency. The adapter protocol is versioned and documented. Contributors can test the project locally.

## Non-goals

### N1 — Replacing Git

WTM wraps and analyzes Git. It does not reimplement Git object storage, branches, merges, rebases, refs or networking.

### N2 — Becoming a package manager

WTM invokes Bun, pnpm, npm, uv, Cargo, Go, Gradle, Maven and other native tools. It does not maintain its own package registry/cache format.

### N3 — Becoming a database management product

WTM can allocate database namespaces through adapters/tasks and own Docker resources, but the core does not implement PostgreSQL/MySQL administration semantics.

### N4 — Becoming Docker Compose

WTM gives each worktree a runtime namespace and environment. Compose remains responsible for container definitions.

### N5 — Automatically committing or pushing user work

WTM may print suggested commands, but destructive or publication decisions stay with the developer/agent under explicit instruction.

### N6 — Supporting every operating system in V1

macOS was the first supported platform, and Linux x64 is now supported alongside it: the operating system is a parameter behind one platform seam, and the same CI gates run on both. Pure core modules hold no platform coupling at all, which a structural test enforces. Windows is not supported and is refused with a coded error rather than half-working. Linux arm64, musl and Alpine are unclaimed, and nothing is released for Linux yet.

### N7 — Solving build caching better than native build systems

WTM can integrate with existing caches. It does not attempt to create a universal compiler cache.

## Success criteria for V1

A fresh user can install WTM, initialize a workspace with multiple repositories, create a new Git worktree using raw Git/Codex/Claude/another GUI, and have WTM detect it without changing Git hooks. The user can start the appropriate workspace command without choosing a port. An AI agent can inspect the environment through JSON. WTM refuses unsafe deletion and provides a precise reason.
