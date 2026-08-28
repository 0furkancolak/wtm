# Standalone Distribution and Examples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship WTM as self-contained macOS arm64/x64 Node 24 SEA executables, retain the npm channel, add Homebrew/release automation, brand install/help/version output, and publish production-validated examples.

**Architecture:** Keep the existing Node/npm bundle and introduce explicit runtime seams for packaged assets, SQLite, process anchors, adapter runners, and LaunchAgent argv. Build a bundled CommonJS SEA bootstrap, inject it into a pinned Node 24 executable on each native macOS architecture, then package verified archives/checksums for GitHub Releases and a generated Homebrew formula.

**Tech Stack:** TypeScript 5.9, Bun 1.3.14 for development/tests/bundling, Node.js 24.18.0 SEA and `node:sqlite`, `better-sqlite3` for npm, Commander 14, postject 1.0.0-alpha.6, GitHub Actions, Homebrew Formula DSL.

**Spec:** `docs/superpowers/specs/2026-08-28-standalone-distribution-and-examples-design.md`

## Global Constraints

- Work directly on `main`; do not create a worktree. The user explicitly authorized main development.
- Relative TypeScript imports never end in `.js`, `.jsx`, `.ts`, or `.tsx`.
- Every `*.test.ts`, `*.scenario.ts`, and test helper lives under the owning module's `__tests__/` directory.
- Production npm runtime requires Node.js 24 or newer; Bun 1.3.14 is development tooling, not an npm consumer runtime engine.
- Standalone V1 pins Node.js 24.18.0, targets macOS arm64 and macOS x64, and must work with no external `node` or `bun` command on `PATH`.
- The npm variant retains `better-sqlite3`; the SEA variant uses `node:sqlite` and contains/extracts no `.node` addon.
- SQL migrations and `skills/wtm/SKILL.md` have one canonical repository source and exact bytes in SEA assets.
- `Powered by https://nafru.com` appears in npm install output, Homebrew caveats, `wtm --help`, and `wtm --version`, never as noise in operational JSON/raw streams.
- Install paths never launch the daemon, scan workspaces, mutate user WTM state, or make network requests.
- Tests never touch real LaunchAgents, user WTM state, global Git configuration, registries, GitHub Releases, or Homebrew installations.
- Do not publish npm, create a Git tag/release, or create an external tap repository during implementation.

## File Structure

- `packages/cli/src/product.ts`: canonical version/brand values and Commander metadata configuration.
- `scripts/postinstall.cjs`: bounded npm install message only.
- `examples/**`: copyable, production-schema-validated configurations and usage notes.
- `packages/core/src/state/database.ts`: runtime-neutral synchronous SQLite interfaces.
- `packages/core/src/state/better-sqlite-driver.ts`: npm `better-sqlite3` adapter.
- `packages/core/src/state/node-sqlite-driver.ts`: SEA `node:sqlite` adapter.
- `packages/core/src/state/assets.ts`: injectable migration byte provider.
- `packages/cli/src/assets.ts`: injectable canonical skill byte provider.
- `packages/cli/src/internal.ts`: hidden runner dispatch before Commander parsing.
- `packages/daemon/src/process-anchor.ts`: callable form of the current process-anchor program.
- `packages/core/src/plan/adapter-runner.ts`: callable guarded adapter child program.
- `packages/cli/src/sea-bin.ts`: SEA bootstrap choosing SEA assets and `node:sqlite`.
- `scripts/build-sea.ts`: host SEA creation/injection/signing.
- `scripts/release-artifacts.ts`: archive/checksum assembly and verification.
- `scripts/render-homebrew-formula.ts`: deterministic versioned formula rendering.
- `packaging/homebrew/wtm.rb.template`: reviewed formula template.
- `.github/workflows/release.yml`: gated tag release, attestations, npm publication, formula update.

---

### Task 1: Product Metadata, Branding, and Safe npm Install Output

**Files:**
- Create: `packages/cli/src/product.ts`
- Create: `scripts/postinstall.cjs`
- Create: `scripts/__tests__/postinstall.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/__tests__/main.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `WTM_VERSION: string`, `WTM_BRAND: 'Powered by https://nafru.com'`, and `configureProductMetadata(program: Command): Command`.
- Consumes: root `package.json` as the only SemVer source.

- [ ] **Step 1: Write failing CLI metadata tests**

Add tests proving `runCli(['--version'])` emits exactly `${version}\nPowered by https://nafru.com\n`, root help contains the brand once, and `runCli(['status', '--json'])` remains parseable JSON without the brand.

```ts
test('prints package version and Nafru attribution', async () => {
  const output = capture();
  expect(await runCli(['--version'], output.io)).toBe(0);
  expect(output.stdout()).toBe('0.1.0\nPowered by https://nafru.com\n');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test packages/cli/src/__tests__/main.test.ts --test-name-pattern 'version|attribution|JSON'`

Expected: FAIL because Commander has no version or help footer.

- [ ] **Step 3: Implement product metadata**

Create `product.ts` with package JSON imported at build time and configure Commander without affecting command output:

```ts
import type { Command } from 'commander';
import metadata from '../../../../package.json' with { type: 'json' };

export const WTM_VERSION = metadata.version;
export const WTM_BRAND = 'Powered by https://nafru.com' as const;

export function configureProductMetadata(program: Command): Command {
  return program.version(`${WTM_VERSION}\n${WTM_BRAND}`).addHelpText('after', `\n${WTM_BRAND}\n`);
}
```

Call it when the root command is constructed and export the constants from `packages/cli/src/index.ts`.

- [ ] **Step 4: Write and verify a failing postinstall isolation test**

The test spawns `node scripts/postinstall.cjs` in an empty temporary directory, asserts exact stdout, empty stderr, exit 0, and that directory entries remain unchanged.

Run: `bun test scripts/__tests__/postinstall.test.ts`

Expected: FAIL because the script does not exist.

- [ ] **Step 5: Implement the bounded postinstall script and package metadata**

Use CommonJS with no imports:

```js
'use strict';
process.stdout.write('WTM installed — Powered by https://nafru.com\n');
```

Add `"postinstall": "node scripts/postinstall.cjs"`, include `scripts/postinstall.cjs` in `files`, remove `bun` from `engines`, and keep `packageManager: "bun@1.3.14"`.

- [ ] **Step 6: Verify GREEN**

Run: `bun test packages/cli/src/__tests__/main.test.ts scripts/__tests__/postinstall.test.ts && bun run lint && bun run typecheck`

Expected: all selected tests pass, lint/typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json packages/cli/src/product.ts packages/cli/src/main.ts packages/cli/src/index.ts packages/cli/src/__tests__/main.test.ts scripts/postinstall.cjs scripts/__tests__/postinstall.test.ts
git commit -m "feat: add WTM product branding"
```

### Task 2: Production-Validated Open-Source Examples and Quick Start

**Files:**
- Create: `examples/README.md`
- Create: `examples/minimal/wtm.toml`
- Create: `examples/bun-monorepo/README.md`
- Create: `examples/bun-monorepo/wtm.toml`
- Create: `examples/docker-compose/README.md`
- Create: `examples/docker-compose/wtm.toml`
- Create: `examples/polyglot/README.md`
- Create: `examples/polyglot/wtm.toml`
- Create: `packages/core/src/config/__tests__/examples.test.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseWtmConfig`, `resolveTask`, and supported fields in `packages/core/src/config/schema.ts`.
- Produces: four published example configurations and npm package inclusion of `examples/`.

- [ ] **Step 1: Write the failing example inventory/schema test**

Read the four exact files from repository root, parse with `smol-toml`, validate with `parseWtmConfig`, and assert:

```ts
expect(Object.keys(config.tasks ?? {})).not.toHaveLength(0);
expect(minimal.workspace?.name).toBe('minimal');
expect(bun.environment?.PORT).toBe('{port.web}');
expect(compose.environment?.COMPOSE_PROJECT_NAME).toBe('{workspace.name}-{repo.name}-wt{id}');
expect(polyglot.capabilities?.['python.environment-manager']).toBe('uv');
expect(polyglot.tasks?.['python-test']?.cwd).toBe('{worktree.root}/services/api');
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/core/src/config/__tests__/examples.test.ts`

Expected: FAIL with missing `examples/*/wtm.toml`.

- [ ] **Step 3: Add minimal, Bun monorepo, Compose, and polyglot configs**

Use only schema-supported V1 fields. Commands are argv arrays; shell form is not used. Each config includes `version = 1`, `[workspace]`, and at least one task. The Compose config defines explicit `compose-up`/`compose-down`; no event starts Docker. The polyglot config defines top-level `js-test`, `python-test`, and `rust-test` tasks with explicit `{worktree.root}/services/...` working directories and selects uv through top-level capabilities.

- [ ] **Step 4: Add example READMEs and root quick start**

Document Homebrew (release channel), direct binary plus `shasum -a 256 -c SHA256SUMS`, npm, and source installation distinctly. Show:

```bash
wtm init --yes
wtm daemon install
wtm status
wtm resolve dev
wtm start dev
wtm logs dev --follow
wtm stop dev
wtm analyze --all
```

Do not claim that a release already exists. Add `examples/` to `package.json.files` and place the brand link in README.

- [ ] **Step 5: Verify GREEN and npm inclusion**

Run: `bun test packages/core/src/config/__tests__/examples.test.ts && bun run build && npm pack --dry-run --json --ignore-scripts > /tmp/wtm-pack.json && rg 'examples/.+wtm.toml' /tmp/wtm-pack.json`

Expected: tests pass and all four configs appear in dry-run JSON.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json examples packages/core/src/config/__tests__/examples.test.ts
git commit -m "docs: add production-validated WTM examples"
```

### Task 3: Canonical Runtime Asset Providers

**Files:**
- Create: `packages/core/src/state/assets.ts`
- Create: `packages/core/src/state/__tests__/assets.test.ts`
- Create: `packages/cli/src/assets.ts`
- Create: `packages/cli/src/__tests__/assets.test.ts`
- Modify: `packages/core/src/state/sqlite-store.ts`
- Modify: `packages/cli/src/commands/skill.ts`

**Interfaces:**
- Produces: `MigrationAssetProvider.readMigrations(): readonly string[]`, `SkillAssetProvider.readCanonicalSkill(): Promise<string>`, filesystem providers, and injection seams.
- Consumes: canonical migration SQL files and `skills/wtm/SKILL.md`.

- [ ] **Step 1: Write failing exact-byte provider tests**

Assert the filesystem migration provider returns eight ordered strings exactly equal to files `001` through `008`; assert the skill provider equals the repository `SKILL.md`. Inject sentinel providers into `SQLiteStateStore` and `readCanonicalSkill` and prove consumers use them rather than `import.meta.url` directly.

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/core/src/state/__tests__/assets.test.ts packages/cli/src/__tests__/assets.test.ts`

Expected: FAIL because provider APIs do not exist.

- [ ] **Step 3: Implement focused providers**

Use these contracts:

```ts
export interface MigrationAssetProvider { readMigrations(): readonly string[] }
export interface SkillAssetProvider { readCanonicalSkill(): Promise<string> }
```

`SQLiteStateStore` accepts `{ readonly?: boolean; migrationAssets?: MigrationAssetProvider }` at this stage while preserving existing callers. Task 4 extends the same options object with `databaseFactory`. `readCanonicalSkill(provider = filesystemSkillAssets)` delegates to the provider. Keep layout/path validation inside filesystem provider implementations.

- [ ] **Step 4: Verify GREEN and existing regression suites**

Run: `bun test packages/core/src/state/__tests__/assets.test.ts packages/core/src/state/__tests__/sqlite-store.test.ts packages/cli/src/__tests__/assets.test.ts packages/cli/src/commands/__tests__/skill.test.ts`

Expected: all pass with canonical byte equality.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/state packages/cli/src/assets.ts packages/cli/src/__tests__/assets.test.ts packages/cli/src/commands/skill.ts
git commit -m "refactor: isolate canonical runtime assets"
```

### Task 4: Runtime-Neutral SQLite Contract and SEA Driver

**Files:**
- Create: `packages/core/src/state/database.ts`
- Create: `packages/core/src/state/better-sqlite-driver.ts`
- Create: `packages/core/src/state/node-sqlite-driver.ts`
- Create: `packages/core/src/state/__tests__/database-contract.scenario.ts`
- Create: `packages/core/src/state/__tests__/database-contract.test.ts`
- Modify: `packages/core/src/state/sqlite-store.ts`
- Modify: `packages/core/tsconfig.json`

**Interfaces:**
- Produces: `SqliteDatabase`, `SqliteStatement`, `SqliteTransaction`, `SqliteDatabaseFactory`, `betterSqliteDatabaseFactory`, `nodeSqliteDatabaseFactory`.
- Consumes: Task 3 `MigrationAssetProvider` injection.

- [ ] **Step 1: Write a failing shared driver contract scenario**

Run the scenario once under Bun with `betterSqliteDatabaseFactory` and once under Node 24 with `nodeSqliteDatabaseFactory`. For each driver, create a real temporary database through `SQLiteStateStore`, register workspace/repository/worktree, allocate an endpoint, reserve/create/update a process, create adapter trust and resource records, close/reopen readonly, and compare normalized JSON results.

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/core/src/state/__tests__/database-contract.test.ts`

Expected: FAIL because driver contracts and Node driver do not exist.

- [ ] **Step 3: Define the minimal synchronous database contract**

```ts
export interface SqliteStatement {
  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
}
export interface SqliteTransaction<T> { (): T; immediate(): T }
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): void;
  transaction<T>(fn: () => T): SqliteTransaction<T>;
  close(): void;
}
export type SqliteDatabaseFactory = (path: string, options: { readonly: boolean }) => SqliteDatabase;
```

- [ ] **Step 4: Implement the existing better-sqlite3 adapter**

Move dependency-specific construction and types out of `sqlite-store.ts`. Preserve `fileMustExist` for readonly databases and `.transaction(fn).immediate()` semantics.

- [ ] **Step 5: Implement the node:sqlite adapter**

Wrap `DatabaseSync`. Implement `pragma(sql)` through `exec('PRAGMA ' + sql)`. Implement `transaction(fn).immediate()` with `BEGIN IMMEDIATE`, `COMMIT`, and rollback-on-error, rejecting nested wrapper transactions if the database reports an active transaction. Normalize statement `run` metadata and readonly open behavior to the contract.

- [ ] **Step 6: Inject the factory without changing the public store API**

Default `SQLiteStateStore` to `betterSqliteDatabaseFactory`; allow SEA bootstrap to pass `nodeSqliteDatabaseFactory`. Keep `node-sqlite-driver.ts` outside the general `packages/core/src/index.ts` export graph so Bun tests and npm consumers do not evaluate `node:sqlite`; the SEA bootstrap imports that internal module directly. Do not expose raw Node database handles.

- [ ] **Step 7: Verify GREEN under both runtimes**

Run: `bun test packages/core/src/state/__tests__/database-contract.test.ts packages/core/src/state/__tests__/sqlite-store.test.ts && node --import tsx packages/core/src/state/__tests__/database-contract.scenario.ts node-sqlite`

Expected: equivalent normalized results and all state tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/state packages/core/tsconfig.json
git commit -m "feat: add Node SEA SQLite driver"
```

### Task 5: Self-Contained Internal Process and Adapter Runners

**Files:**
- Create: `packages/daemon/src/process-anchor.ts`
- Create: `packages/daemon/src/__tests__/process-anchor.test.ts`
- Create: `packages/core/src/plan/adapter-runner.ts`
- Create: `packages/core/src/plan/__tests__/adapter-runner.test.ts`
- Create: `packages/cli/src/internal.ts`
- Create: `packages/cli/src/__tests__/internal.test.ts`
- Modify: `packages/daemon/src/process-supervisor.ts`
- Modify: `packages/core/src/plan/external-adapter.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/main.ts`

**Interfaces:**
- Produces: `runProcessAnchor(marker: string): Promise<number>`, `runAdapterChild(descriptor: number, basename: string): Promise<number>`, `runInternalMode(argv): Promise<number | null>`, and `RuntimeInvocation` `{ executable: string; prefixArgs: readonly string[] }`.
- Consumes: existing anchor protocol/source behavior and adapter trust descriptor/guard behavior.

- [ ] **Step 1: Write failing internal dispatch and no-PATH-runtime tests**

Assert public help omits internal modes; malformed `__wtm_internal_anchor` and `__wtm_internal_adapter` return nonzero without private details. Spawn the CLI with `PATH` containing only fixture task commands and prove managed start/stop and adapter invocation never resolve `node` or `bun` from PATH when `RuntimeInvocation` points at the current executable.

- [ ] **Step 2: Run and verify RED**

Run: `bun test packages/cli/src/__tests__/internal.test.ts packages/daemon/src/__tests__/process-anchor.test.ts packages/core/src/plan/__tests__/adapter-runner.test.ts`

Expected: FAIL because internal modes are absent and supervisors still launch `node -e`.

- [ ] **Step 3: Extract the process anchor into a callable module**

Move the current anchor program behavior without changing its handshake, process-group identity, log path audits, abort behavior, fingerprint, or cleanup. `spawnAnchor` receives a `RuntimeInvocation`; it spawns:

```ts
[...runtime.prefixArgs, '__wtm_internal_anchor', plannedCommandFingerprint(input)]
```

The npm default is `{ executable: process.execPath, prefixArgs: [resolve(process.argv[1]!)] }`; SEA passes `{ executable: process.execPath, prefixArgs: [] }`.

- [ ] **Step 4: Extract the guarded adapter child**

Replace `--import/--eval` argv with the same internal invocation pattern. In the child, call `registerHooks` before importing `/dev/fd/<descriptor>`, deny `node:module` and every non-entry non-builtin dependency exactly as today, cap output, and preserve timeout/process-group cleanup. The parent still opens exact trusted bytes on an unlinked private descriptor.

- [ ] **Step 5: Dispatch internal modes before Commander**

`bin.ts` first calls `runInternalMode(process.argv.slice(2))`; `null` means public CLI, while a numeric result is assigned to `process.exitCode` without constructing Commander. Validate marker shape (`^[a-f0-9]{64}$`), descriptor integer range, basename, and exact arity. Import runner modules through explicit internal relative paths; do not expose hidden modes from package public indexes.

- [ ] **Step 6: Make LaunchAgent argv runtime-aware**

Export a pure `daemonProgramArguments(invocation)` function. npm yields `[nodePath, cliPath, 'daemon', 'serve']`; SEA yields `[wtmPath, 'daemon', 'serve']`. Keep dependency injection in lifecycle tests so no real launchctl call occurs.

- [ ] **Step 7: Verify GREEN and security regressions**

Run: `bun test packages/cli/src/__tests__/internal.test.ts packages/daemon/src/__tests__/process-anchor.test.ts packages/daemon/src/__tests__/process-supervisor.test.ts packages/core/src/plan/__tests__/adapter-runner.test.ts packages/core/src/plan/__tests__/external-adapter.test.ts packages/cli/src/commands/__tests__/daemon.test.ts`

Expected: all tests pass, including existing race, timeout, oversized-output, and dependency-denial cases.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/plan packages/daemon/src packages/cli/src
git commit -m "feat: run WTM children through its own executable"
```

### Task 6: Node SEA Builder, Embedded Assets, and Artifact Verification

**Files:**
- Create: `packages/cli/src/sea-bin.ts`
- Create: `packages/cli/src/sea-assets.ts`
- Create: `scripts/build-sea.ts`
- Create: `scripts/release-artifacts.ts`
- Create: `scripts/__tests__/build-sea.test.ts`
- Create: `scripts/__tests__/release-artifacts.test.ts`
- Create: `scripts/__tests__/sea-smoke.scenario.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `build:binary`, `binary:verify`, `release:artifacts`; `dist/sea/wtm`; deterministic `wtm-darwin-{arch}.tar.gz` and `SHA256SUMS`.
- Consumes: Task 3 asset providers, Task 4 `nodeSqliteDatabaseFactory`, Task 5 SEA `RuntimeInvocation`.

- [ ] **Step 1: Write failing builder config/unit tests**

Inject command/file/process adapters into `buildSea`. Assert exact Node SEA config keys (`main`, `output`, `disableExperimentalSEAWarning`, `assets`), eight ordered migrations plus skill, version equality, postject injection arguments, signature verification, executable mode, and cleanup after a failed step.

- [ ] **Step 2: Run and verify RED**

Run: `bun test scripts/__tests__/build-sea.test.ts scripts/__tests__/release-artifacts.test.ts`

Expected: FAIL because builder modules do not exist.

- [ ] **Step 3: Implement SEA bootstrap and providers**

`sea-bin.ts` installs SEA dependencies explicitly, then runs internal/public dispatch. `sea-assets.ts` calls `isSea()` and `getAsset(name, 'utf8')`, requires exact keys `migration/001` through `migration/008` and `skill/wtm/SKILL.md`, and returns providers matching Tasks 3/4.

- [ ] **Step 4: Implement host SEA build**

Add exact dev dependency `postject@1.0.0-alpha.6`. Bundle `sea-bin.ts` as one CommonJS script, write SEA JSON, execute Node 24.18.0 with `--experimental-sea-config`, copy the host Node executable, remove its existing macOS signature, inject `NODE_SEA_BLOB` using the local pinned postject executable, apply ad-hoc signing for local verification, and run `codesign --verify`. All shell commands use argv arrays and checked exit codes.

- [ ] **Step 5: Implement binary smoke scenario**

With a sanitized PATH containing required system tools but no Node/Bun, run `--version`, `--help`, init a temporary Git workspace, validate persistent SQLite migration/status/resolve/analyze, start/stop a fixture task, run daemon serve only with injected temp paths, and invoke a trusted fixture adapter. Assert no repository-relative asset read and no `.node` extraction.

- [ ] **Step 6: Implement release archive/checksum assembly**

Each tar contains `wtm`, `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.md`; `wtm` mode is `0755`. Generate sorted two-space SHA-256 lines and reject host/declared architecture mismatch using `file`/Mach-O inspection.

- [ ] **Step 7: Verify GREEN with a real local SEA**

Run: `bun run build:binary && bun run binary:verify && bun test scripts/__tests__/build-sea.test.ts scripts/__tests__/release-artifacts.test.ts`

Expected: real current-host executable passes smoke tests and unit suites.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock .gitignore packages/cli/src/sea-bin.ts packages/cli/src/sea-assets.ts scripts/build-sea.ts scripts/release-artifacts.ts scripts/__tests__
git commit -m "feat: build standalone WTM executables"
```

### Task 7: Homebrew Formula and Gated Release Automation

**Files:**
- Create: `packaging/homebrew/wtm.rb.template`
- Create: `scripts/render-homebrew-formula.ts`
- Create: `scripts/__tests__/render-homebrew-formula.test.ts`
- Create: `scripts/verify-release.ts`
- Create: `scripts/__tests__/verify-release.test.ts`
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `docs/12-open-source-distribution.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: deterministic formula renderer, tag/version gate, tag-only release workflow.
- Consumes: Task 6 archives and `SHA256SUMS`; Task 1 package version/brand.

- [ ] **Step 1: Write failing formula and release-gate tests**

Assert rendering version `1.2.3` with two 64-hex digests produces architecture blocks with immutable GitHub Release URLs, Apache-2.0, `bin.install "wtm"`, isolated `--version`/`--help` tests, and exact caveats. Assert tag `v1.2.3` accepts package `1.2.3`; missing `v`, prerelease mismatch, malformed SemVer, or unequal version rejects.

- [ ] **Step 2: Run and verify RED**

Run: `bun test scripts/__tests__/render-homebrew-formula.test.ts scripts/__tests__/verify-release.test.ts`

Expected: FAIL because render/verification modules do not exist.

- [ ] **Step 3: Implement deterministic formula rendering**

Template rendering for test version `1.2.3` produces `on_arm`/`on_intel`, stable URLs `https://github.com/0furkancolak/wtm/releases/download/v1.2.3/wtm-darwin-arm64.tar.gz` and `https://github.com/0furkancolak/wtm/releases/download/v1.2.3/wtm-darwin-x64.tar.gz`, exact digest substitution, `version`, `license "Apache-2.0"`, direct binary installation, and:

```ruby
def caveats
  <<~EOS
    WTM installed — Powered by https://nafru.com
    Run `wtm init --yes` inside a workspace to get started.
  EOS
end
```

- [ ] **Step 4: Implement tag/version and artifact gates**

Parse checksums without guessing, require exactly both expected archives, verify local digests, package version, executable smoke results, and stable-release signing status before returning a release manifest.

- [ ] **Step 5: Add least-privilege tag workflow**

Use native macOS arm64/x64 matrix jobs, pinned Bun/Node versions, frozen install, full `release:verify`, SEA build/smoke, signed stable-release gate, checksums, `actions/attest@v4`, GitHub Release upload, npm trusted publishing/provenance, then formula rendering/update. Set permissions per job (`contents`, `id-token`, `attestations`) and guard every publication job with `startsWith(github.ref, 'refs/tags/v')`. Ordinary CI only builds/verifies the current-host SEA and never publishes.

- [ ] **Step 6: Document truthful release operations**

Update distribution docs and changelog with prepared channels, required secrets/trusted publisher setup, signing policy, explicit custom tap command, and the fact that no public artifact exists until a matching tag workflow succeeds.

- [ ] **Step 7: Verify GREEN and workflow syntax**

Run: `bun test scripts/__tests__/render-homebrew-formula.test.ts scripts/__tests__/verify-release.test.ts && ruby -c artifacts/formula/wtm.rb && bun run lint && bun run typecheck && bun run package:verify`

The formula test renders `artifacts/formula/wtm.rb` from fixed test digests before the Ruby syntax check. Parse both workflow YAML files with the workspace YAML parser used by the verification script. Expected: tests and syntax checks pass; dry-run package includes scripts/examples/assets and excludes release secrets. The tag workflow alone writes `Formula/wtm.rb` after uploaded assets and final checksums exist.

- [ ] **Step 8: Commit**

```bash
git add packaging scripts .github/workflows package.json docs/12-open-source-distribution.md CHANGELOG.md
git commit -m "chore: automate WTM binary releases"
```

### Task 8: Whole-Release Verification and Public Documentation Audit

**Files:**
- Modify only files required by failures discovered in this task.
- Test additions must remain under the owning `__tests__/` directory.

**Interfaces:**
- Consumes: every prior task deliverable.
- Produces: one verified release candidate with no publication side effects.

- [ ] **Step 1: Run the full serial suite**

Run: `bun run test --timeout 30000`

Expected: zero failures.

- [ ] **Step 2: Run static and build gates**

Run: `bun run lint && bun run typecheck && bun run build && bun install --frozen-lockfile`

Expected: all exit 0 and frozen install changes no tracked file.

- [ ] **Step 3: Run integration, performance, package, and binary gates**

Run: `bun run test:e2e && bun run test:perf && bun run package:verify && bun run build:binary && bun run binary:verify`

Expected: every gate passes; performance stays within existing blocker thresholds.

- [ ] **Step 4: Audit public claims and artifact contents**

Compare README/docs/examples/Formula commands to actual CLI help and package scripts. Inspect npm dry-run and SEA archive members. Verify exact brand spelling, extensionless imports, test placement, `git diff --check`, no real release/tag, no LaunchAgent/user-state mutation, and clean temporary resources.

- [ ] **Step 5: Fix only evidence-backed failures with RED/GREEN tests**

For each discovered defect, first add the smallest failing regression under `__tests__/`, run it to observe the intended failure, implement the minimal fix, and rerun the focused plus affected full gate.

- [ ] **Step 6: Commit consolidated verification fixes**

```bash
git add README.md CHANGELOG.md package.json bun.lock packages scripts examples packaging .github docs
git commit -m "chore: harden standalone WTM release"
```
