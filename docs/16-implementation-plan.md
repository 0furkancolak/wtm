# WTM V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS-first, TypeScript worktree runtime manager that initializes existing workspaces, discovers Git worktrees, resolves workspace tasks/env/ports, provides AI-readable diagnostics, safely analyzes/removes worktrees, and supervises optional runtime processes.

**Architecture:** A Bun TypeScript workspace separates protocol, core, built-in adapters, daemon, CLI, and testkit. Runtime packages remain compatible with Node.js 24 LTS. Git porcelain output is the topology source of truth; the daemon uses event-driven macOS directory watching and reconciles into SQLite state. Destructive operations are mediated by core safety policy and external adapters use short-lived versioned JSON processes.

**Tech Stack:** Node.js 24 LTS compatibility, Bun 1.3+ workspaces and `bun:test`, TypeScript strict, Commander, Zod, smol-toml, better-sqlite3, picocolors, native Node `fs.watch`/`child_process`/Unix sockets.

**Spec:** `docs/README.md` and documents `01` through `18`, especially `02-architecture.md`, `03-configuration-spec.md`, `10-git-safety-worktree-analysis.md`, and ADRs.

## Global Constraints

- macOS is the only required V1 platform.
- Node.js runtime floor is 24 LTS.
- Bun 1.3+ is the development package manager, script runner and test runner.
- No Git-hook installation is required for correctness.
- No source-tree polling loop.
- `wtm remove` has no loss-bypassing force option.
- No automatic commit, push, reset, clean, or source discard.
- Config and adapter JSON are validated before use.
- Shell execution defaults to argv arrays; shell strings require explicit `shell = true`.
- Every operational command has stable JSON unless it is a raw streaming command.
- Rust may not be introduced unless a benchmark-backed ADR is approved.

---

## Target file structure

```text
package.json
tsconfig.base.json
bunfig.toml

packages/protocol/src/
  index.ts
  schema-version.ts
  errors.ts
  adapter.ts
  ipc.ts
  json-envelope.ts

packages/core/src/
  config/
  git/
  workspace/
  analysis/
  plan/
  runtime/
  resources/
  state/
  templates/

packages/adapters/src/
  registry.ts
  make.ts
  bun.ts
  pnpm.ts
  npm.ts
  next.ts
  uv.ts
  cargo.ts
  go.ts
  docker-compose.ts

packages/daemon/src/
  main.ts
  server.ts
  watcher.ts
  reconciler-queue.ts
  process-supervisor.ts
  launchd.ts
  logs.ts

packages/cli/src/
  main.ts
  client.ts
  output.ts
  commands/*.ts

packages/testkit/src/
  git-fixture.ts
  workspace-fixture.ts
  fake-adapter.ts

skills/wtm/SKILL.md
```

### Task 1: Bootstrap workspace and shared protocol

**Files:**
- Create: root package/tooling files above.
- Create: `packages/protocol/src/*.ts`.
- Test: `packages/protocol/src/*.test.ts`.

**Interfaces:**
- Produces `JsonEnvelope<T>`, `WtmError`, `ProtocolVersion`, adapter request/response schemas.

- [ ] **Step 1: Write failing protocol tests**

```ts
import { describe, expect, it } from 'bun:test';
import { jsonEnvelopeSchema } from './json-envelope.js';

describe('jsonEnvelopeSchema', () => {
  it('rejects an envelope without schemaVersion', () => {
    expect(() => jsonEnvelopeSchema.parse({ ok: true, command: 'status', data: {} })).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
bun test packages/protocol/src/json-envelope.test.ts
```

Expected: failure because the schema/module does not exist.

- [ ] **Step 3: Implement the minimal protocol types/schemas**

Define Zod schemas and inferred TypeScript types for the V1 envelope and error item exactly as documented in `18-errors-json-contract.md`.

- [ ] **Step 4: Run protocol tests**

```bash
bun test packages/protocol/src
```

Expected: all protocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock bunfig.toml tsconfig.base.json packages/protocol
git commit -m "feat: bootstrap WTM protocol workspace"
```

### Task 2: Git command runner and porcelain worktree parser

**Files:**
- Create: `packages/core/src/git/git-runner.ts`
- Create: `packages/core/src/git/worktree-parser.ts`
- Create: `packages/testkit/src/git-fixture.ts`
- Test: `packages/core/src/git/worktree-parser.test.ts`
- Test: `packages/core/src/git/git-runner.integration.test.ts`

**Interfaces:**

```ts
export interface GitWorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  lockedReason: string | null;
  prunableReason: string | null;
}

export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeRecord[]>;
```

- [ ] **Step 1: Write parser tests including NUL-separated paths**

Construct byte fixtures representing `git worktree list --porcelain -z` with normal, detached and locked worktrees.

- [ ] **Step 2: Verify tests fail**

```bash
bun test packages/core/src/git/worktree-parser.test.ts
```

- [ ] **Step 3: Implement a byte-safe parser and runner**

Runner must use `spawn`/`execFile` argv, never shell interpolation, and invoke:

```text
git -C <repoPath> worktree list --porcelain -z
```

- [ ] **Step 4: Add real temporary-repo integration coverage**

Use the testkit to create a repo, linked worktree, detached worktree and lock one worktree. Compare parsed records with expected state.

- [ ] **Step 5: Run tests and commit**

```bash
bun test packages/core/src/git packages/testkit
git add packages/core/src/git packages/testkit
git commit -m "feat: parse Git worktree topology"
```

### Task 3: Config loading, inheritance, templates and provenance

**Files:**
- Create: `packages/core/src/config/schema.ts`
- Create: `packages/core/src/config/load.ts`
- Create: `packages/core/src/config/merge.ts`
- Create: `packages/core/src/config/provenance.ts`
- Create: `packages/core/src/templates/resolve.ts`
- Test: corresponding `*.test.ts` files.

**Interfaces:**

```ts
export interface ResolvedConfig<T> {
  value: T;
  provenance: Map<string, { source: string; line?: number }>;
}

export async function resolveWorkspaceConfig(input: {
  workspaceRoot: string;
  repoRoot?: string;
  globalConfigPath: string;
}): Promise<ResolvedConfig<WtmConfig>>;

export function resolveTemplate(value: string, ctx: TemplateContext): string;
```

- [ ] **Step 1: Write merge precedence tests**

Cover global < workspace < nested < repo-local and ensure adapter defaults remain below explicit config.

- [ ] **Step 2: Write unresolved-template failure test**

`{port.unknown}` must produce `WTM_TEMPLATE_UNRESOLVED`.

- [ ] **Step 3: Run tests to verify failure**

```bash
bun test packages/core/src/config packages/core/src/templates
```

- [ ] **Step 4: Implement parsing/validation with `smol-toml` + Zod**

Preserve source file provenance during merge. Reject `run` combined with `main/worktree`.

- [ ] **Step 5: Re-run and commit**

```bash
bun test packages/core/src/config packages/core/src/templates
git add packages/core/src/config packages/core/src/templates
git commit -m "feat: resolve WTM configuration"
```

### Task 4: SQLite state store and stable identities

**Files:**
- Create: `packages/core/src/state/store.ts`
- Create: `packages/core/src/state/sqlite-store.ts`
- Create: `packages/core/src/state/migrations/001-initial.sql`
- Test: `packages/core/src/state/sqlite-store.test.ts`

**Interfaces:**

```ts
export interface StateStore {
  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord;
  upsertRepository(input: RepositoryInput): RepositoryRecord;
  reconcileWorktrees(repoId: string, snapshot: GitWorktreeRecord[]): ReconcileResult;
  allocateEndpoint(input: EndpointRequest): EndpointLease;
  transaction<T>(fn: () => T): T;
}
```

- [ ] **Step 1: Write tests for persistent worktree numeric IDs and transaction rollback**
- [ ] **Step 2: Verify failure**

```bash
bun test packages/core/src/state/sqlite-store.test.ts
```

- [ ] **Step 3: Implement `better-sqlite3` store behind `StateStore`**

Enable foreign keys and WAL mode. Use parameterized queries only.

- [ ] **Step 4: Verify persistence by closing/reopening a temporary DB**
- [ ] **Step 5: Run and commit**

```bash
bun test packages/core/src/state
git add packages/core/src/state
git commit -m "feat: add persistent WTM state store"
```

### Task 5: Workspace discovery and `wtm init`

**Files:**
- Create: `packages/core/src/workspace/discover.ts`
- Create: `packages/core/src/workspace/init.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/testkit/src/workspace-fixture.ts`
- Test: discovery/init integration tests.

**Interfaces:**

```ts
export async function discoverWorkspace(root: string, options: DiscoveryOptions): Promise<DiscoveryReport>;
export async function initializeWorkspace(input: InitInput): Promise<InitResult>;
```

- [ ] **Step 1: Build fixture with workspace Makefile, two repos and an existing linked worktree**
- [ ] **Step 2: Write failing test expecting all repos/worktrees and task marker detection**
- [ ] **Step 3: Implement bounded recursive discovery with ignore roots and `.git` file/dir recognition**
- [ ] **Step 4: Implement local vs `--global` registration behavior**
- [ ] **Step 5: Add CLI JSON output test**
- [ ] **Step 6: Run and commit**

```bash
bun test packages/core/src/workspace packages/cli/src/commands/init.test.ts
git add packages/core/src/workspace packages/cli/src/commands/init.ts packages/testkit
git commit -m "feat: initialize existing WTM workspaces"
```

### Task 6: Advanced Git analysis and deletion safety

**Files:**
- Create: `packages/core/src/analysis/worktree-analysis.ts`
- Create: `packages/core/src/analysis/remote-persistence.ts`
- Create: `packages/core/src/analysis/remove-policy.ts`
- Create: `packages/cli/src/commands/analyze.ts`
- Create: `packages/cli/src/commands/remove.ts`
- Test: comprehensive Git safety integration suite.

**Interfaces:**

```ts
export interface WorktreeSafety {
  readiness: 'SAFE' | 'REVIEW' | 'BLOCKED';
  blockers: WtmError[];
  warnings: WtmError[];
}

export async function analyzeWorktree(ctx: WorktreeContext): Promise<WorktreeAnalysis>;
export function assertRemovable(analysis: WorktreeAnalysis): void;
```

- [ ] **Step 1: Create local bare remote test harness**
- [ ] **Step 2: Write one failing test for every mandatory blocker from spec**
- [ ] **Step 3: Implement machine parsing of Git status/upstream/ahead-behind/remote containment**
- [ ] **Step 4: Implement `assertRemovable` with no force bypass**
- [ ] **Step 5: Add safe clean/pushed worktree removal integration test**
- [ ] **Step 6: Run and commit**

```bash
bun test packages/core/src/analysis packages/cli/src/commands/remove.test.ts
git add packages/core/src/analysis packages/cli/src/commands/analyze.ts packages/cli/src/commands/remove.ts
git commit -m "feat: add safe worktree analysis and removal"
```

### Task 7: Task resolver, environment and stable endpoint allocation

**Files:**
- Create: `packages/core/src/runtime/task-resolver.ts`
- Create: `packages/core/src/runtime/endpoints.ts`
- Create: `packages/core/src/runtime/environment.ts`
- Create: `packages/cli/src/commands/resolve.ts`
- Create: `packages/cli/src/commands/run.ts`
- Test: runtime tests.

**Interfaces:**

```ts
export interface ResolvedTask {
  argv: string[];
  shell: boolean;
  cwd: string;
  envDelta: Record<string, string>;
  background: boolean;
  singleton: boolean;
}
```

- [ ] **Step 1: Write test where main resolves `make dev` and linked worktree #3 resolves `make dev-with-worktree-3`**
- [ ] **Step 2: Write concurrent endpoint allocation test**
- [ ] **Step 3: Implement stable-dynamic allocation with OS bind probe**
- [ ] **Step 4: Implement task/env/template resolution**
- [ ] **Step 5: Implement foreground `wtm run` and dry `wtm resolve`**
- [ ] **Step 6: Run and commit**

```bash
bun test packages/core/src/runtime packages/cli/src/commands/resolve.test.ts
git add packages/core/src/runtime packages/cli/src/commands/resolve.ts packages/cli/src/commands/run.ts
git commit -m "feat: resolve tasks and worktree runtime endpoints"
```

### Task 8: Built-in adapter graph

**Files:**
- Create: `packages/adapters/src/registry.ts`
- Create adapter files listed in target structure.
- Test: `packages/adapters/src/*.test.ts`.

**Interfaces:**

```ts
export interface BuiltInAdapter {
  metadata(): AdapterMetadata;
  detect(ctx: AdapterContext): Promise<DetectionResult>;
  plan(ctx: AdapterContext): Promise<AdapterPlan>;
  doctor(ctx: AdapterContext): Promise<DoctorCheck[]>;
}
```

- [ ] **Step 1: Write marker detection tests for Make/Bun/pnpm/npm/Next/uv/Cargo/Go/Compose**
- [ ] **Step 2: Write ambiguity test for multiple JS lockfiles**
- [ ] **Step 3: Implement minimal side-effect-free detect/plan functions**
- [ ] **Step 4: Verify resource policies keep mutable outputs isolated**
- [ ] **Step 5: Run and commit**

```bash
bun test packages/adapters
git add packages/adapters
git commit -m "feat: add built-in ecosystem adapters"
```

### Task 9: CLI diagnostics and JSON contract

**Files:**
- Create: `packages/cli/src/main.ts`
- Create: `packages/cli/src/output.ts`
- Create commands: `status.ts`, `doctor.ts`, `explain.ts`, `plan.ts`, `env.ts`, `ports.ts`.
- Test: command snapshot/schema tests.

- [ ] **Step 1: Write JSON schema compliance tests for success and failure**
- [ ] **Step 2: Implement Commander command tree and output abstraction**
- [ ] **Step 3: Ensure human output and JSON output share core data, not separate logic**
- [ ] **Step 4: Test `--global` aggregation only over registered workspaces**
- [ ] **Step 5: Run and commit**

```bash
bun test packages/cli
git add packages/cli
git commit -m "feat: expose WTM diagnostics CLI"
```

### Task 10: Daemon IPC, watcher and startup reconciliation

**Files:**
- Create daemon files `main.ts`, `server.ts`, `watcher.ts`, `reconciler-queue.ts`.
- Create: `packages/cli/src/client.ts`
- Test: daemon integration tests with temporary socket/state paths.

- [ ] **Step 1: Write failing test that a raw `git worktree add` causes a reconciled new record**
- [ ] **Step 2: Implement Unix socket framed JSON server/client**
- [ ] **Step 3: Implement registered-workspace `fs.watch` wrapper with 200 ms debounce**
- [ ] **Step 4: Implement startup full reconciliation**
- [ ] **Step 5: Add test proving ordinary source edits do not call adapter discovery**
- [ ] **Step 6: Run and commit**

```bash
bun test packages/daemon packages/cli/src/client.test.ts
git add packages/daemon packages/cli/src/client.ts
git commit -m "feat: add WTM daemon reconciliation"
```

### Task 11: Managed process supervisor and logs

**Files:**
- Create: `packages/daemon/src/process-supervisor.ts`
- Create: `packages/daemon/src/logs.ts`
- Create CLI commands: `start.ts`, `stop.ts`, `restart.ts`, `ps.ts`, `logs.ts`, `exec.ts`.
- Test: process-group integration tests.

- [ ] **Step 1: Write test fixture command that spawns a child process**
- [ ] **Step 2: Verify stopping task terminates the whole owned group**
- [ ] **Step 3: Write test where stored PID identity is stale and ensure unrelated process is not killed**
- [ ] **Step 4: Implement daemon-owned spawn with detached process group and file log redirection**
- [ ] **Step 5: Implement singleton behavior**
- [ ] **Step 6: Run and commit**

```bash
bun test packages/daemon/src/process-supervisor.test.ts packages/cli/src/commands
git add packages/daemon packages/cli/src/commands
git commit -m "feat: supervise worktree runtime processes"
```

### Task 12: launchd lifecycle

**Files:**
- Create: `packages/daemon/src/launchd.ts`
- Create CLI command: `packages/cli/src/commands/daemon.ts`
- Test: plist generation tests; install tests use isolated fake home/path and do not load real user agents.

- [ ] **Step 1: Write deterministic plist snapshot test**
- [ ] **Step 2: Implement install/uninstall/status command generation**
- [ ] **Step 3: Add explicit foreground `wtm daemon serve`**
- [ ] **Step 4: Run tests and manually verify in a disposable macOS test user/environment before release**
- [ ] **Step 5: Commit**

```bash
bun test packages/daemon/src/launchd.test.ts packages/cli/src/commands/daemon.test.ts
git add packages/daemon/src/launchd.ts packages/cli/src/commands/daemon.ts
git commit -m "feat: manage macOS WTM launch agent"
```

### Task 13: Resource storage, APFS-safe plan and GC

**Files:**
- Create: `packages/core/src/resources/materializer.ts`
- Create: `packages/core/src/resources/guard.ts`
- Create: `packages/core/src/resources/gc.ts`
- Create CLI commands: `disk.ts`, `gc.ts`.
- Test: deletion sandbox/security tests.

- [ ] **Step 1: Write tests rejecting `/`, home, `.git`, tracked files and symlink escape**
- [ ] **Step 2: Implement policy materialization for symlink/copy/isolated/generated**
- [ ] **Step 3: Implement clone capability abstraction with copy fallback**
- [ ] **Step 4: Implement safe GC and `--dry-run` plan**
- [ ] **Step 5: Run all resource security tests**
- [ ] **Step 6: Commit**

```bash
bun test packages/core/src/resources packages/cli/src/commands/gc.test.ts
git add packages/core/src/resources packages/cli/src/commands/disk.ts packages/cli/src/commands/gc.ts
git commit -m "feat: add safe WTM resource lifecycle"
```

### Task 14: External adapter bridge and trust

**Files:**
- Create: `packages/core/src/plan/external-adapter.ts`
- Create: `packages/core/src/plan/adapter-trust.ts`
- Create CLI command: `adapter.ts`
- Extend testkit fake adapter.

- [ ] **Step 1: Write tests for protocol mismatch, timeout, malformed JSON and untrusted repo-local adapter**
- [ ] **Step 2: Implement stdin/stdout JSON bridge with strict timeout and schema validation**
- [ ] **Step 3: Implement SHA-256 trust records**
- [ ] **Step 4: Verify changed adapter hash invalidates trust**
- [ ] **Step 5: Run and commit**

```bash
bun test packages/core/src/plan packages/cli/src/commands/adapter.test.ts
git add packages/core/src/plan packages/cli/src/commands/adapter.ts packages/testkit
git commit -m "feat: support trusted external WTM adapters"
```

### Task 15: Agent Skill installer and AI contract

**Files:**
- Use: `skills/wtm/SKILL.md`
- Create: `packages/cli/src/commands/skill.ts`
- Test: skill command tests.

- [ ] **Step 1: Write test that `wtm skill print` exactly emits the canonical skill**
- [ ] **Step 2: Implement install adapter abstraction for local/global Agent Skill locations**
- [ ] **Step 3: Ensure init can skip installation via `--no-ai-skill`**
- [ ] **Step 4: Test no project `AGENTS.md` is modified implicitly**
- [ ] **Step 5: Commit**

```bash
bun test packages/cli/src/commands/skill.test.ts packages/cli/src/commands/init.test.ts
git add skills/wtm/SKILL.md packages/cli/src/commands/skill.ts packages/cli/src/commands/init.ts
git commit -m "feat: ship WTM agent skill"
```

### Task 16: Performance, security and release verification

**Files:**
- Create: `tests/perf/idle-daemon.ts`
- Create: `tests/perf/workspace-scale.ts`
- Create: `tests/e2e/full-workflow.test.ts`
- Create public repo policy files from `12-open-source-distribution.md`.

- [ ] **Step 1: Build 10-repo/100-worktree generated benchmark fixture**
- [ ] **Step 2: Measure idle CPU/RSS and record results in CI artifact**
- [ ] **Step 3: Verify source edit storm does not trigger adapter spawns**
- [ ] **Step 4: Run complete safety E2E: init -> raw worktree add -> status -> task resolve -> analyze -> blocked dirty remove -> push/clean fixture -> safe remove**
- [ ] **Step 5: Run full validation**

```bash
bun run lint
bun run typecheck
bun test
bun run test:e2e
bun run test:perf
```

Expected: all commands exit 0 and the performance report stays inside the release budgets in `14-testing-performance-security.md`.

- [ ] **Step 6: Commit release hardening**

```bash
git add .github CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md SUPPORT.md CHANGELOG.md tests
git commit -m "chore: harden WTM for public release"
```

## Final implementation verification

Before calling V1 implementation complete, verify every requirement in docs `01` through `18`, run the full command suite above, run `git status --short`, and inspect the generated public package contents to ensure the skill/docs/license are included.
