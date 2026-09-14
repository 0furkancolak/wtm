# Multi-repository `wtm create` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wtm create <branch> --repos a,b,c` creates one worktree per named repository under one persistent feature, journals every member, and `wtm create <branch> --resume` finishes a partial creation without re-running an uncertain step or deleting anything.

**Architecture:** Migration 014 adds `features`, `feature_creations`, `feature_creation_members` and rebuilds `repository_operation_leases` to allow `create`. Pure core functions resolve `--repos` names, plan every member with pinned start OIDs, and classify a journalled member against observed Git state. A new CLI command module orchestrates: plan → ordered `create` leases → second pre-flight → journal → apply → register → complete, and the same pipeline for `--resume`.

**Tech Stack:** Bun + TypeScript monorepo, better-sqlite3, Commander, `bun:test`, node `--import tsx` scenario children.

**Spec:** `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`

## Global Constraints

- Package direction: `protocol` ← `platform` ← `core` ← `daemon`/`cli`. `@wtm/core` must not import `@wtm/platform`, and must not mention `process.platform` or `process.getuid` anywhere, comments included (structural tests enforce this).
- Targeted tests: `bun test --timeout 60000 <files>`. Full gate: `bun run typecheck && bun run lint && bun run test` (about 4–5 min). Never run two full suites at once: they share daemon sockets.
- Scenario children run under `node --import tsx` through `runScenario` from `packages/testkit/src/scenario-child.ts`; the `*.test.ts` file only spawns and asserts JSON.
- Optional properties are spread, never assigned `undefined`: `...(value === undefined ? {} : { value })` (the repo compiles with `exactOptionalPropertyTypes`).
- JSON envelope `schemaVersion: 1`. No new error codes. Codes used: `WTM_CONFIG_INVALID`, `WTM_NOT_INITIALIZED`, `WTM_OPERATION_CONFLICT`, `WTM_WORKTREE_PATH_OCCUPIED`, `GIT_BRANCH_IN_USE`, `GIT_REPOSITORY_DEGRADED`, `GIT_COMMAND_FAILED`; warning `WTM_DAEMON_UNAVAILABLE`.
- Single-repository `wtm create <branch>` (no `--repos`, no `--resume`) behaves exactly as today and takes no lease.
- Create and resume never delete a worktree, branch, directory or journal row.
- Migration file name: `014-feature-creations.sql`. Branches are journalled as full refs (`refs/heads/<name>`).
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/state/migrations/014-feature-creations.sql` (new) | Lease table rebuild; feature and journal tables |
| `packages/core/src/state/assets.ts` | Canonical migration list |
| `packages/core/src/state/store.ts` | `RepositoryOperation` gains `create`; feature/journal records; `FeatureCreationStore` |
| `packages/core/src/state/sqlite-store.ts` | `create` lease skips heavy-job guard; `FeatureCreationStore` implementation |
| `packages/core/src/analysis/operation-lease.ts` | `session.renew()`; `withRepositoryOperationLeases` |
| `packages/core/src/analysis/create-feature.ts` (new) | `resolveFeatureMembers`, `planFeatureCreation`, `resolveCommit` |
| `packages/core/src/analysis/create-feature-recovery.ts` (new) | `classifyMemberRecovery` |
| `packages/core/src/index.ts` | Exports |
| `packages/cli/src/commands/create.ts` | Export shared helpers |
| `packages/cli/src/commands/create-feature.ts` (new) | Orchestration for `--repos` and `--resume` |
| `packages/cli/src/main.ts` | `--repos`, `--resume` options; `featureCreateApply` test seam |
| Docs | `docs/04`, `docs/18`, `docs/03`, `CHANGELOG.md`, `todo.md`, 2026-09-07 spec |

---

### Task 1: Migration 014, `create` lease operation, heavy-job guard

**Files:**
- Create: `packages/core/src/state/migrations/014-feature-creations.sql`
- Modify: `packages/core/src/state/assets.ts` (append to `migrationFileNames`)
- Modify: `packages/core/src/state/__tests__/assets.test.ts` (expected list and test title)
- Modify: `packages/core/src/state/store.ts` (`RepositoryOperation`)
- Modify: `packages/core/src/state/sqlite-store.ts` (`acquireRepositoryOperationLease`)
- Create: `packages/core/src/state/__tests__/feature-creations-migration.scenario.ts`
- Create: `packages/core/src/state/__tests__/feature-creations-migration.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: tables `features`, `feature_creations`, `feature_creation_members`; `RepositoryOperation = 'remove' | 'gc' | 'repair' | 'create'`.

- [ ] **Step 1: Write the failing scenario and test**

`packages/core/src/state/__tests__/feature-creations-migration.scenario.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemMigrationAssets } from '../assets';
import { betterSqliteDatabaseFactory } from '../better-sqlite-driver';
import { SQLiteStateStore } from '../sqlite-store';

const leaseColumns = `repository_id, operation, token, pid, process_start_time, subject_worktree_id,
  stage, acquired_at, renewed_at, expires_at, host_id`;

const root = await mkdtemp(join(tmpdir(), 'wtm-feature-migration-'));
const path = join(root, 'state.db');
try {
  const old = new SQLiteStateStore(path, {
    migrationAssets: { readMigrations: () => filesystemMigrationAssets.readMigrations().slice(0, 13) },
  });
  const workspace = old.upsertWorkspace({ name: 'ws', root: '/ws', scope: 'local', configPath: '/ws/wtm.toml' });
  const leased = old.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/a/.git', mainRoot: '/ws/a', remoteIdentity: null });
  const queued = old.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/b/.git', mainRoot: '/ws/b', remoteIdentity: null });
  old.close();

  const raw = betterSqliteDatabaseFactory(path, { readonly: false });
  raw.prepare(`INSERT INTO repository_operation_leases (${leaseColumns}) VALUES
    (?, 'remove', 'token-1', 4242, 'Mon Aug 31 10:00:00 2026', NULL, 'git-remove',
     '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'host-a')`).run(leased.id);
  const before = raw.prepare('SELECT * FROM repository_operation_leases').all();
  raw.close();

  const upgraded = new SQLiteStateStore(path);
  upgraded.close();

  const after = betterSqliteDatabaseFactory(path, { readonly: false });
  let tables: string[];
  try {
    assert.deepEqual(after.prepare('SELECT * FROM repository_operation_leases').all(), before);
    after.prepare(`INSERT INTO repository_operation_leases (${leaseColumns}) VALUES
      (?, 'create', 'token-2', 4243, 'x', NULL, NULL, 'a', 'a', '2999-01-01T00:00:00.000Z', 'host-a')`).run(queued.id);
    assert.throws(() => after.prepare(`INSERT INTO repository_operation_leases (${leaseColumns}) VALUES
      (?, 'bogus', 'token-3', 4244, 'x', NULL, NULL, 'a', 'a', 'a', 'host-a')`).run(leased.id), /CHECK constraint failed/);
    after.prepare("DELETE FROM repository_operation_leases WHERE operation = 'create'").run();
    tables = (after.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('features', 'feature_creations', 'feature_creation_members') ORDER BY name`).all() as Array<{ name: string }>)
      .map(({ name }) => name);
    // A queued heavy job in repository b: create must not care, remove must still refuse.
    after.prepare(`INSERT INTO heavy_jobs (job_id, scope, workspace_id, repository_id, worktree_id, worktree_path,
      task_name, idempotency_key, command_fingerprint, source_fingerprint, timeout_ms, state,
      slot_held, anchor_pid, stop_reason, created_at, started_at) VALUES
      ('queued', 'host:user', ?, ?, 'tree', '/ws/b', 'build', 'key', 'command', 'source', 60000, 'QUEUED',
      0, NULL, NULL, '2026-09-13T00:00:00.000Z', NULL)`).run(workspace.id, queued.id);
  } finally { after.close(); }

  const store = new SQLiteStateStore(path);
  let createLease: string;
  let removeRefusal: string;
  try {
    const request = { repositoryId: queued.id, token: 'token-4', pid: 1, processStartTime: 'x', hostId: 'host-a', ttlMs: 120_000 };
    createLease = store.acquireRepositoryOperationLease({ ...request, operation: 'create' }, '2026-09-13T00:00:00.000Z').outcome;
    store.releaseRepositoryOperationLease({ repositoryId: queued.id, operation: 'create' }, 'token-4');
    try {
      store.acquireRepositoryOperationLease({ ...request, token: 'token-5', operation: 'remove' }, '2026-09-13T00:00:00.000Z');
      removeRefusal = 'acquired';
    } catch (error) {
      removeRefusal = (error as { code?: string }).code ?? 'unknown';
    }
  } finally { store.close(); }

  console.log(JSON.stringify({ leasesPreserved: true, tables, createLease, removeRefusal }));
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
```

`packages/core/src/state/__tests__/feature-creations-migration.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('migration 14 keeps every lease row, admits create, and adds the feature journal', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./feature-creations-migration.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    leasesPreserved: true,
    tables: ['feature_creation_members', 'feature_creations', 'features'],
    // create only adds a worktree, so a queued job elsewhere in the repository is no reason to refuse it.
    createLease: 'acquired',
    // remove, gc and repair keep the guard.
    removeRefusal: 'WTM_OPERATION_CONFLICT',
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --timeout 60000 packages/core/src/state/__tests__/feature-creations-migration.test.ts`
Expected: FAIL (the scenario throws on the `'create'` insert: `CHECK constraint failed`).

- [ ] **Step 3: Write the migration**

`packages/core/src/state/migrations/014-feature-creations.sql`:

```sql
-- Multi-repository `wtm create` (spec 2026-09-13-multi-repo-create-design.md).
--
-- `repository_operation_leases` is rebuilt only to widen its CHECK: SQLite cannot alter a CHECK
-- in place. Every column, including migration 011's `host_id`, is copied unchanged.
CREATE TABLE repository_operation_leases_next (
  repository_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  operation           TEXT NOT NULL CHECK (operation IN ('remove', 'gc', 'repair', 'create')),
  token               TEXT NOT NULL,
  pid                 INTEGER NOT NULL,
  process_start_time  TEXT NOT NULL,
  subject_worktree_id TEXT,
  stage               TEXT,
  acquired_at         TEXT NOT NULL,
  renewed_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  host_id             TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repository_id, operation)
);

INSERT INTO repository_operation_leases_next (
  repository_id, operation, token, pid, process_start_time, subject_worktree_id, stage,
  acquired_at, renewed_at, expires_at, host_id
)
SELECT
  repository_id, operation, token, pid, process_start_time, subject_worktree_id, stage,
  acquired_at, renewed_at, expires_at, host_id
FROM repository_operation_leases;

DROP TABLE repository_operation_leases;
ALTER TABLE repository_operation_leases_next RENAME TO repository_operation_leases;

CREATE INDEX idx_repository_operation_lease_expiry
  ON repository_operation_leases(expires_at);

-- A feature is the runtime's existing grouping, "one workspace, one full branch ref", given a
-- durable id. The grouping rule itself is unchanged, so the row and the group cannot disagree.
CREATE TABLE features (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  branch       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, branch)
);

CREATE TABLE feature_creations (
  id           TEXT PRIMARY KEY,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  state        TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'SUPERSEDED')),
  from_ref     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX feature_creations_one_open
  ON feature_creations(feature_id) WHERE state = 'IN_PROGRESS';

-- `repository_id` has no foreign key on purpose: forgetting a repository must leave the member
-- visible, so `--resume` can refuse by naming it instead of silently finishing without it.
CREATE TABLE feature_creation_members (
  creation_id          TEXT NOT NULL REFERENCES feature_creations(id) ON DELETE CASCADE,
  repository_id        TEXT NOT NULL,
  repository_main_root TEXT NOT NULL,
  position             INTEGER NOT NULL,
  worktree_path        TEXT NOT NULL,
  branch_existed       INTEGER NOT NULL CHECK (branch_existed IN (0, 1)),
  start_oid            TEXT NOT NULL,
  phase                TEXT NOT NULL CHECK (phase IN ('PLANNED', 'APPLYING', 'APPLIED', 'REGISTERED')),
  last_error_code      TEXT,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (creation_id, repository_id),
  UNIQUE (creation_id, position)
);
```

- [ ] **Step 4: Register the migration and widen the operation type**

In `packages/core/src/state/assets.ts`, append `'014-feature-creations.sql',` after `'013-heavy-job-memory.sql',`.

In `packages/core/src/state/__tests__/assets.test.ts`, append `'014-feature-creations.sql',` to the expected list after `'013-heavy-job-memory.sql',` and rename the test `'reads the thirteen canonical migrations in exact byte order'` to `'reads the fourteen canonical migrations in exact byte order'`.

In `packages/core/src/state/store.ts`, replace:

```ts
/** The destructive operations that take a repository-wide lease before they start. */
export type RepositoryOperation = 'remove' | 'gc' | 'repair';
```

with:

```ts
/**
 * The operations that take a repository-wide lease before they start: the three that destroy,
 * and a multi-repository `create`, which holds its members still while it journals and writes.
 */
export type RepositoryOperation = 'remove' | 'gc' | 'repair' | 'create';
```

In `packages/core/src/state/sqlite-store.ts`, inside `acquireRepositoryOperationLease`, replace:

```ts
      assertNoHeavyJobs(this.#database, input.repositoryId);
```

with:

```ts
      // The heavy-job guard protects work a destructive operation could pull out from under a
      // job. A create only adds a worktree, so a job queued elsewhere in the repository is no
      // reason to refuse it.
      if (input.operation !== 'create') assertNoHeavyJobs(this.#database, input.repositoryId);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test --timeout 60000 packages/core/src/state/__tests__/feature-creations-migration.test.ts packages/core/src/state/__tests__/assets.test.ts packages/core/src/analysis/__tests__/operation-lease.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck`
Expected: clean. (If a `switch` over `RepositoryOperation` somewhere is now non-exhaustive, add a `create` branch that matches its `remove` sibling's wording, and include that file in the commit.)

```bash
git add packages/core/src/state/migrations/014-feature-creations.sql packages/core/src/state/assets.ts packages/core/src/state/__tests__/assets.test.ts packages/core/src/state/store.ts packages/core/src/state/sqlite-store.ts packages/core/src/state/__tests__/feature-creations-migration.scenario.ts packages/core/src/state/__tests__/feature-creations-migration.test.ts
git commit -m "feat: add migration 014 for feature creations and a create lease (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `FeatureCreationStore`

**Files:**
- Modify: `packages/core/src/state/store.ts` (append types and interface)
- Modify: `packages/core/src/state/sqlite-store.ts` (implement)
- Modify: `packages/core/src/index.ts` (export types)
- Create: `packages/core/src/state/__tests__/feature-creations.scenario.ts`
- Create: `packages/core/src/state/__tests__/feature-creations.test.ts`

**Interfaces:**
- Consumes: migration 014 (Task 1).
- Produces (exported from `@wtm/core`):

```ts
export type FeatureCreationState = 'IN_PROGRESS' | 'COMPLETED' | 'SUPERSEDED';
export type FeatureCreationPhase = 'PLANNED' | 'APPLYING' | 'APPLIED' | 'REGISTERED';
export interface FeatureRecord { id: string; workspaceId: string; branch: string; createdAt: string }
export interface FeatureCreationMemberInput {
  repositoryId: string; repositoryMainRoot: string; position: number;
  worktreePath: string; branchExisted: boolean; startOid: string;
}
export interface FeatureCreationMemberRecord extends FeatureCreationMemberInput {
  creationId: string; phase: FeatureCreationPhase; lastErrorCode: string | null; updatedAt: string;
}
export interface FeatureCreationRecord {
  id: string; feature: FeatureRecord; state: FeatureCreationState; fromRef: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  members: FeatureCreationMemberRecord[]; // ordered by position
}
export interface BeginFeatureCreationInput {
  workspaceId: string; branch: string; fromRef: string | null;
  members: readonly FeatureCreationMemberInput[];
  supersedeCreationId?: string | undefined;
}
export interface FeatureCreationStore {
  upsertFeature(workspaceId: string, branch: string): FeatureRecord;
  beginFeatureCreation(input: BeginFeatureCreationInput): FeatureCreationRecord;
  advanceCreationMember(creationId: string, repositoryId: string, phase: FeatureCreationPhase, lastErrorCode: string | null): void;
  completeFeatureCreation(creationId: string): void;
  supersedeFeatureCreation(creationId: string): void;
  readOpenFeatureCreation(workspaceId: string, branch: string): FeatureCreationRecord | null;
  readFeatureCreation(creationId: string): FeatureCreationRecord | null;
}
```

- [ ] **Step 1: Write the failing scenario and test**

`packages/core/src/state/__tests__/feature-creations.scenario.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteStateStore } from '../sqlite-store';

const root = mkdtempSync(join(tmpdir(), 'wtm-feature-creations-'));
const path = join(root, 'state.db');
const outcome = (fn: () => unknown): string => { try { fn(); return 'ok'; } catch { return 'refused'; } };

try {
  const store = new SQLiteStateStore(path);
  const workspace = store.upsertWorkspace({ name: 'ws', root: '/ws', scope: 'local', configPath: '/ws/wtm.toml' });
  const web = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/web/.git', mainRoot: '/ws/web', remoteIdentity: null });
  const api = store.upsertRepository({ workspaceId: workspace.id, commonGitDir: '/ws/api/.git', mainRoot: '/ws/api', remoteIdentity: null });
  const branch = 'refs/heads/feat/auth';
  const members = [
    { repositoryId: web.id, repositoryMainRoot: '/ws/web', position: 0, worktreePath: '/ws/web-feat-auth', branchExisted: false, startOid: 'a'.repeat(40) },
    { repositoryId: api.id, repositoryMainRoot: '/ws/api', position: 1, worktreePath: '/ws/api-feat-auth', branchExisted: true, startOid: 'b'.repeat(40) },
  ];

  const sameFeature = store.upsertFeature(workspace.id, branch).id === store.upsertFeature(workspace.id, branch).id;
  const first = store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: null, members });
  const secondOpenWhileFirstOpen = outcome(() => store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: null, members }));
  const openAfterBegin = store.readOpenFeatureCreation(workspace.id, branch);

  // Every member still PLANNED: superseding is allowed and replaces the open creation.
  const superseding = store.beginFeatureCreation({ workspaceId: workspace.id, branch, fromRef: 'main', members, supersedeCreationId: first.id });
  const firstAfterSupersede = store.readFeatureCreation(first.id)?.state;

  store.advanceCreationMember(superseding.id, web.id, 'APPLYING', null);
  store.advanceCreationMember(superseding.id, web.id, 'PLANNED', 'GIT_COMMAND_FAILED');
  const afterFailure = store.readFeatureCreation(superseding.id)?.members.map((m) => [m.phase, m.lastErrorCode]);
  store.advanceCreationMember(superseding.id, web.id, 'APPLIED', null);
  const supersedeOnceApplied = outcome(() => store.supersedeFeatureCreation(superseding.id));
  const completeBeforeRegistered = outcome(() => store.completeFeatureCreation(superseding.id));
  store.advanceCreationMember(superseding.id, web.id, 'REGISTERED', null);
  store.advanceCreationMember(superseding.id, api.id, 'REGISTERED', null);
  store.completeFeatureCreation(superseding.id);
  const completed = store.readFeatureCreation(superseding.id);
  const openAfterComplete = store.readOpenFeatureCreation(workspace.id, branch);

  // Forgetting a repository leaves its member rows, so resume can name it.
  const third = store.beginFeatureCreation({ workspaceId: workspace.id, branch: 'refs/heads/feat/other', fromRef: null, members });
  store.forgetRepository(api.id);
  const membersAfterForgetRepository = store.readFeatureCreation(third.id)?.members.length;
  store.close();

  // Forgetting a workspace cascades features, creations and members.
  const raw = new Database(path);
  raw.pragma('foreign_keys = ON');
  raw.prepare('DELETE FROM worktrees').run();
  raw.prepare('DELETE FROM repositories').run();
  raw.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
  const rowsAfterForgetWorkspace = ['features', 'feature_creations', 'feature_creation_members']
    .map((table) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  raw.close();

  console.log(JSON.stringify({
    sameFeature,
    firstState: first.state,
    firstMembers: first.members.map((m) => [m.position, m.phase, m.branchExisted]),
    secondOpenWhileFirstOpen,
    openAfterBegin: openAfterBegin?.id === first.id,
    supersedingState: superseding.state,
    supersedingFromRef: superseding.fromRef,
    firstAfterSupersede,
    afterFailure,
    supersedeOnceApplied,
    completeBeforeRegistered,
    completedState: completed?.state,
    completedAtSet: completed?.completedAt !== null,
    openAfterComplete,
    membersAfterForgetRepository,
    rowsAfterForgetWorkspace,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
```

`packages/core/src/state/__tests__/feature-creations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

test('the feature creation journal keeps one open creation per feature and guards its transitions', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./feature-creations.scenario.ts', import.meta.url))]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    sameFeature: true,
    firstState: 'IN_PROGRESS',
    firstMembers: [[0, 'PLANNED', false], [1, 'PLANNED', true]],
    secondOpenWhileFirstOpen: 'refused',
    openAfterBegin: true,
    supersedingState: 'IN_PROGRESS',
    supersedingFromRef: 'main',
    firstAfterSupersede: 'SUPERSEDED',
    afterFailure: [['PLANNED', 'GIT_COMMAND_FAILED'], ['PLANNED', null]],
    supersedeOnceApplied: 'refused',
    completeBeforeRegistered: 'refused',
    completedState: 'COMPLETED',
    completedAtSet: true,
    openAfterComplete: null,
    membersAfterForgetRepository: 2,
    rowsAfterForgetWorkspace: [0, 0, 0],
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --timeout 60000 packages/core/src/state/__tests__/feature-creations.test.ts`
Expected: FAIL (`store.upsertFeature is not a function`).

- [ ] **Step 3: Add the types and interface**

Append to `packages/core/src/state/store.ts` the full `Produces` block above, with this doc comment on `FeatureCreationStore`:

```ts
/**
 * The multi-repository creation journal (spec 2026-09-13-multi-repo-create-design.md).
 *
 * Kept apart from `StateStore` on purpose: that interface's key set is pinned by a type-level
 * test and implemented by test doubles, none of which have anything to say about features.
 */
```

- [ ] **Step 4: Implement it in `SQLiteStateStore`**

Change the class declaration to `export class SQLiteStateStore implements StateStore, FeatureCreationStore {` and import the new types from `./store`. Add these row types near the other row types:

```ts
interface FeatureRow { id: string; workspace_id: string; branch: string; created_at: string }
interface FeatureCreationRow {
  id: string; feature_id: string; state: FeatureCreationState; from_ref: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
}
interface FeatureCreationMemberRow {
  creation_id: string; repository_id: string; repository_main_root: string; position: number;
  worktree_path: string; branch_existed: number; start_oid: string; phase: FeatureCreationPhase;
  last_error_code: string | null; updated_at: string;
}
```

Add these methods to the class:

```ts
  upsertFeature(workspaceId: string, branch: string): FeatureRecord {
    this.#assertOpen();
    this.#database.prepare(`
      INSERT INTO features (id, workspace_id, branch, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace_id, branch) DO NOTHING
    `).run(randomUUID(), workspaceId, branch, new Date().toISOString());
    const row = this.#database.prepare('SELECT * FROM features WHERE workspace_id = ? AND branch = ?')
      .get(workspaceId, branch) as FeatureRow;
    return { id: row.id, workspaceId: row.workspace_id, branch: row.branch, createdAt: row.created_at };
  }

  /**
   * Opens a creation with every member PLANNED, in one transaction. The partial unique index is
   * what refuses a second open creation of the same feature, so two racing callers cannot both
   * journal one.
   */
  beginFeatureCreation(input: BeginFeatureCreationInput): FeatureCreationRecord {
    this.#assertOpen();
    if (input.members.length === 0) throw new TypeError('A feature creation needs at least one member');
    return this.transaction(() => {
      const feature = this.upsertFeature(input.workspaceId, input.branch);
      if (input.supersedeCreationId !== undefined) this.#supersede(input.supersedeCreationId, feature.id);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.#database.prepare(`
        INSERT INTO feature_creations (id, feature_id, state, from_ref, created_at, updated_at, completed_at)
        VALUES (?, ?, 'IN_PROGRESS', ?, ?, ?, NULL)
      `).run(id, feature.id, input.fromRef, timestamp, timestamp);
      const insert = this.#database.prepare(`
        INSERT INTO feature_creation_members (
          creation_id, repository_id, repository_main_root, position, worktree_path, branch_existed,
          start_oid, phase, last_error_code, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', NULL, ?)
      `);
      for (const member of input.members) {
        insert.run(id, member.repositoryId, member.repositoryMainRoot, member.position, member.worktreePath,
          member.branchExisted ? 1 : 0, member.startOid, timestamp);
      }
      return this.#featureCreation(id)!;
    });
  }

  advanceCreationMember(creationId: string, repositoryId: string, phase: FeatureCreationPhase, lastErrorCode: string | null): void {
    this.#assertOpen();
    this.transaction(() => {
      const timestamp = new Date().toISOString();
      const changed = this.#database.prepare(`
        UPDATE feature_creation_members SET phase = ?, last_error_code = ?, updated_at = ?
        WHERE creation_id = ? AND repository_id = ?
      `).run(phase, lastErrorCode, timestamp, creationId, repositoryId).changes;
      if (changed !== 1) throw new Error(`Creation ${creationId} has no member for repository ${repositoryId}`);
      this.#database.prepare('UPDATE feature_creations SET updated_at = ? WHERE id = ?').run(timestamp, creationId);
    });
  }

  /** Only an open creation whose every member is REGISTERED can complete. */
  completeFeatureCreation(creationId: string): void {
    this.#assertOpen();
    this.transaction(() => {
      const timestamp = new Date().toISOString();
      const changed = this.#database.prepare(`
        UPDATE feature_creations SET state = 'COMPLETED', updated_at = ?, completed_at = ?
        WHERE id = ? AND state = 'IN_PROGRESS' AND NOT EXISTS (
          SELECT 1 FROM feature_creation_members m
          WHERE m.creation_id = feature_creations.id AND m.phase <> 'REGISTERED'
        )
      `).run(timestamp, timestamp, creationId).changes;
      if (changed !== 1) throw new Error(`Creation ${creationId} is not an open creation with every member registered`);
    });
  }

  supersedeFeatureCreation(creationId: string): void {
    this.#assertOpen();
    this.transaction(() => this.#supersede(creationId, null));
  }

  readOpenFeatureCreation(workspaceId: string, branch: string): FeatureCreationRecord | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT c.id FROM feature_creations c JOIN features f ON f.id = c.feature_id
      WHERE f.workspace_id = ? AND f.branch = ? AND c.state = 'IN_PROGRESS'
    `).get(workspaceId, branch) as { id: string } | undefined;
    return row === undefined ? null : this.#featureCreation(row.id);
  }

  readFeatureCreation(creationId: string): FeatureCreationRecord | null {
    this.#assertOpen();
    return this.#featureCreation(creationId);
  }

  /** Nothing was written to Git while every member is PLANNED, which is the only time a creation may be replaced. */
  #supersede(creationId: string, featureId: string | null): void {
    const changed = this.#database.prepare(`
      UPDATE feature_creations SET state = 'SUPERSEDED', updated_at = ?
      WHERE id = ? AND (? IS NULL OR feature_id = ?) AND state = 'IN_PROGRESS' AND NOT EXISTS (
        SELECT 1 FROM feature_creation_members m
        WHERE m.creation_id = feature_creations.id AND m.phase <> 'PLANNED'
      )
    `).run(new Date().toISOString(), creationId, featureId, featureId).changes;
    if (changed !== 1) throw new Error(`Creation ${creationId} cannot be superseded: it is not open with every member still PLANNED`);
  }

  #featureCreation(creationId: string): FeatureCreationRecord | null {
    const creation = this.#database.prepare('SELECT * FROM feature_creations WHERE id = ?')
      .get(creationId) as FeatureCreationRow | undefined;
    if (creation === undefined) return null;
    const feature = this.#database.prepare('SELECT * FROM features WHERE id = ?').get(creation.feature_id) as FeatureRow;
    const members = this.#database.prepare('SELECT * FROM feature_creation_members WHERE creation_id = ? ORDER BY position')
      .all(creationId) as FeatureCreationMemberRow[];
    return {
      id: creation.id,
      feature: { id: feature.id, workspaceId: feature.workspace_id, branch: feature.branch, createdAt: feature.created_at },
      state: creation.state,
      fromRef: creation.from_ref,
      createdAt: creation.created_at,
      updatedAt: creation.updated_at,
      completedAt: creation.completed_at,
      members: members.map((row) => ({
        creationId: row.creation_id,
        repositoryId: row.repository_id,
        repositoryMainRoot: row.repository_main_root,
        position: row.position,
        worktreePath: row.worktree_path,
        branchExisted: row.branch_existed === 1,
        startOid: row.start_oid,
        phase: row.phase,
        lastErrorCode: row.last_error_code,
        updatedAt: row.updated_at,
      })),
    };
  }
```

In `packages/core/src/index.ts`, export the types next to the other state types:

```ts
export type {
  BeginFeatureCreationInput,
  FeatureCreationMemberInput,
  FeatureCreationMemberRecord,
  FeatureCreationPhase,
  FeatureCreationRecord,
  FeatureCreationState,
  FeatureCreationStore,
  FeatureRecord,
} from './state/store';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test --timeout 60000 packages/core/src/state/__tests__/feature-creations.test.ts packages/core/src/state/__tests__/sqlite-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run typecheck`
Expected: clean.

```bash
git add packages/core/src/state/store.ts packages/core/src/state/sqlite-store.ts packages/core/src/index.ts packages/core/src/state/__tests__/feature-creations.scenario.ts packages/core/src/state/__tests__/feature-creations.test.ts
git commit -m "feat: journal multi-repository creations in the state store (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Ordered leases across repositories

**Files:**
- Modify: `packages/core/src/analysis/operation-lease.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/analysis/__tests__/operation-lease.test.ts` (append)

**Interfaces:**
- Consumes: `RepositoryOperation` with `create` (Task 1).
- Produces:

```ts
export interface RepositoryOperationSession { /* existing */ renew(): void }
export interface RepositoryOperationLeasesInput
  extends Omit<RepositoryOperationLeaseInput, 'repositoryId' | 'subjectWorktreeId'> {
  repositoryIds: readonly string[];
}
export interface RepositoryOperationLeasesSession {
  /** The distinct repository ids, in acquisition order. */
  readonly repositoryIds: readonly string[];
  /** Renews every held lease; throws if any has expired. */
  renewAll(): void;
}
export function withRepositoryOperationLeases<T>(
  input: RepositoryOperationLeasesInput,
  body: (session: RepositoryOperationLeasesSession) => Promise<T>,
): Promise<T>;
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/analysis/__tests__/operation-lease.test.ts` (add `withRepositoryOperationLeases` to the existing import from `'../operation-lease'`):

```ts
class OrderSpyStore extends FakeLeaseStore {
  readonly events: string[] = [];

  override acquireRepositoryOperationLease(input: RepositoryOperationLeaseRequest, now: string): RepositoryOperationLeaseResult {
    this.events.push(`acquire:${input.repositoryId}`);
    return super.acquireRepositoryOperationLease(input, now);
  }

  override renewRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string, now: string, ttlMs: number): boolean {
    this.events.push(`renew:${key.repositoryId}`);
    return super.renewRepositoryOperationLease(key, token, now, ttlMs);
  }

  override releaseRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string): boolean {
    this.events.push(`release:${key.repositoryId}`);
    return super.releaseRepositoryOperationLease(key, token);
  }
}

const onlySelfIsAlive: ProcessStartTimeReader = async (pid) => (pid === process.pid ? selfStartTime : null);

test('multi-repository leases are taken in repository id order and released in reverse', async () => {
  const store = new OrderSpyStore();
  const seen = await withRepositoryOperationLeases({
    store, readProcessStartTime: onlySelfIsAlive, hostId: myHostId,
    repositoryIds: ['repo-c', 'repo-a', 'repo-b', 'repo-a'], operation: 'create',
  }, async (session) => {
    session.renewAll();
    return session.repositoryIds;
  });

  expect(seen).toEqual(['repo-a', 'repo-b', 'repo-c']);
  expect(store.events).toEqual([
    'acquire:repo-a', 'acquire:repo-b', 'acquire:repo-c',
    'renew:repo-a', 'renew:repo-b', 'renew:repo-c',
    'release:repo-c', 'release:repo-b', 'release:repo-a',
  ]);
});

test('a refused repository releases the leases already held and never runs the body', async () => {
  const store = new OrderSpyStore();
  store.seed({
    repositoryId: 'repo-b', operation: 'gc', token: 'held', pid: holderPid, processStartTime: holderStartTime,
    hostId: myHostId, subjectWorktreeId: null, stage: null,
    acquiredAt: '2026-09-13T00:00:00.000Z', renewedAt: '2026-09-13T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
  });
  let ran = false;

  const attempt = withRepositoryOperationLeases({
    store, readProcessStartTime: onlySelfIsAlive, hostId: myHostId,
    repositoryIds: ['repo-c', 'repo-b', 'repo-a'], operation: 'create',
  }, async () => { ran = true; });

  await expect(attempt).rejects.toBeInstanceOf(RepositoryOperationConflictError);
  expect(ran).toBe(false);
  expect(store.events).toEqual(['acquire:repo-a', 'acquire:repo-b', 'release:repo-a']);
  expect([...store.rows.values()].map((row) => row.token)).toEqual(['held']);
});
```

If `FakeLeaseStore` does not already implement `renewRepositoryOperationLease` and `releaseRepositoryOperationLease` as overridable class methods, give it those methods first (renew: update `renewedAt`/`expiresAt` of the row with the matching token when `expiresAt > now`, return whether it did; release: delete the row with the matching token, return whether it did).

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/operation-lease.test.ts`
Expected: FAIL (`withRepositoryOperationLeases` is not exported).

- [ ] **Step 3: Implement**

In `packages/core/src/analysis/operation-lease.ts`, add `renew(): void;` to `RepositoryOperationSession` with the doc comment `/** Extends the lease; throws when it has already expired, because an expired lease is only re-acquirable. */`, and add to the `session` object in `withRepositoryOperationLease`:

```ts
    renew(): void {
      const ttlMs = input.ttlMs ?? defaultOperationLeaseTtlMs;
      if (!input.store.renewRepositoryOperationLease(key, token, now(), ttlMs)) {
        throw new Error(
          `The "${input.operation}" lease on repository ${input.repositoryId} expired before it was renewed.`,
        );
      }
    },
```

Append:

```ts
export interface RepositoryOperationLeasesInput
  extends Omit<RepositoryOperationLeaseInput, 'repositoryId' | 'subjectWorktreeId'> {
  repositoryIds: readonly string[];
}

export interface RepositoryOperationLeasesSession {
  /** The distinct repository ids, in acquisition order. */
  readonly repositoryIds: readonly string[];
  /** Renews every held lease; throws if any has expired. */
  renewAll(): void;
}

/**
 * Holds one lease per repository while `body` runs.
 *
 * Acquisition is in ascending repository id order and never waits, so two callers holding
 * overlapping sets cannot deadlock: whichever reaches a held repository second is refused. The
 * leases nest, so a refusal part-way releases the ones already held, in reverse order, before the
 * refusal reaches the caller.
 */
export async function withRepositoryOperationLeases<T>(
  input: RepositoryOperationLeasesInput,
  body: (session: RepositoryOperationLeasesSession) => Promise<T>,
): Promise<T> {
  const { repositoryIds, ...single } = input;
  const ordered = [...new Set(repositoryIds)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (ordered.length === 0) throw new TypeError('At least one repository must be leased');
  const sessions: RepositoryOperationSession[] = [];
  const acquire = async (index: number): Promise<T> => {
    if (index === ordered.length) {
      return await body({
        repositoryIds: ordered,
        renewAll: () => { for (const session of sessions) session.renew(); },
      });
    }
    return await withRepositoryOperationLease({ ...single, repositoryId: ordered[index]! }, async (session) => {
      sessions.push(session);
      return await acquire(index + 1);
    });
  };
  return await acquire(0);
}
```

In `packages/core/src/index.ts`, add `withRepositoryOperationLeases` to the `./analysis/operation-lease` value export and `RepositoryOperationLeasesInput`, `RepositoryOperationLeasesSession` to its type export.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/operation-lease.test.ts packages/core/src/analysis/__tests__/removal-lifecycle.test.ts packages/core/src/resources/__tests__/gc-repository-lease.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: clean (any other object literal typed as `RepositoryOperationSession`, e.g. in a test fake, needs a `renew` too).

```bash
git add packages/core/src/analysis/operation-lease.ts packages/core/src/index.ts packages/core/src/analysis/__tests__/operation-lease.test.ts
git commit -m "feat: acquire repository operation leases across repositories in order (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Resolve `--repos` and plan every member

**Files:**
- Create: `packages/core/src/analysis/create-feature.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/analysis/__tests__/create-feature.test.ts`

**Interfaces:**
- Consumes: `planWorktreeCreation`, `WorktreeCreationPlan` (existing, `./create-worktree`); `resolveRepoScope` (existing); `RepositoryRecord` (existing).
- Produces (exported from `@wtm/core`):

```ts
export type FeatureMemberResolution =
  | { outcome: 'resolved'; repositories: RepositoryRecord[] } // ascending id = lease order
  | { outcome: 'refused'; error: WtmError };
export function resolveFeatureMembers(input: {
  config: WtmConfig; workspaceRoot: string; repositories: readonly RepositoryRecord[]; names: readonly string[];
}): FeatureMemberResolution;

export interface FeatureMemberMeasurement {
  repository: RepositoryRecord;
  topology: readonly GitWorktreeRecord[];
  branchOid: string | null; // refs/heads/<branch>, null when absent
  fromOid: string | null;   // --from in this repository, null when not given or unresolvable
}
export interface FeatureMemberPlan {
  repository: RepositoryRecord; position: number; plan: WorktreeCreationPlan;
  startOid: string; branchExisted: boolean;
}
export type FeatureCreationDecision =
  | { outcome: 'plan'; members: FeatureMemberPlan[] }
  | { outcome: 'refused'; errors: WtmError[] };
export function planFeatureCreation(input: {
  workspaceRoot: string; branch: string; from?: string | undefined;
  members: readonly FeatureMemberMeasurement[]; pathExists: (path: string) => boolean;
}): FeatureCreationDecision;

export function resolveCommit(repoPath: string, ref: string): Promise<string | null>;
```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/analysis/__tests__/create-feature.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WtmConfig } from '../../config/schema';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import type { RepositoryRecord } from '../../state/store';
import { planFeatureCreation, resolveCommit, resolveFeatureMembers } from '../create-feature';

const repository = (id: string, mainRoot: string): RepositoryRecord => ({
  id, workspaceId: 'ws', commonGitDir: `${mainRoot}/.git`, mainRoot, remoteIdentity: null,
  createdAt: '2026-09-13T00:00:00.000Z', lastReconciledAt: null,
});
const worktree = (path: string, branch: string | null, head: string): GitWorktreeRecord => ({
  path, branch, head, detached: branch === null, bare: false, lockedReason: null, prunableReason: null,
});
const config = (repos?: WtmConfig['repos']): WtmConfig => ({ version: 1, ...(repos === undefined ? {} : { repos }) }) as WtmConfig;

const web = repository('id-2', '/ws/web');
const api = repository('id-1', '/ws/services/api');
const worker = repository('id-3', '/ws/worker');

describe('resolveFeatureMembers', () => {
  test('resolves [repos] names and directory names, deduplicated, in id order', () => {
    const resolution = resolveFeatureMembers({
      config: config({ backend: { path: 'services/api' } } as WtmConfig['repos']),
      workspaceRoot: '/ws', repositories: [web, api, worker], names: ['web', 'backend', 'web'],
    });
    expect(resolution).toEqual({ outcome: 'resolved', repositories: [api, web] });
  });

  test('a repository named by a [repos] entry is not also reachable by its directory name', () => {
    const resolution = resolveFeatureMembers({
      config: config({ backend: { path: 'services/api' } } as WtmConfig['repos']),
      workspaceRoot: '/ws', repositories: [web, api], names: ['api'],
    });
    expect(resolution.outcome).toBe('refused');
  });

  test('unknown and ambiguous names are refused together', () => {
    const twin = repository('id-4', '/ws/other/web');
    const resolution = resolveFeatureMembers({
      config: config(), workspaceRoot: '/ws', repositories: [web, twin, worker], names: ['web', 'nope'],
    });
    expect(resolution).toMatchObject({
      outcome: 'refused',
      error: { code: 'WTM_CONFIG_INVALID', context: { unknown: ['nope'], ambiguous: ['web'] } },
    });
  });
});

describe('planFeatureCreation', () => {
  const nothingExists = () => false;

  test('pins each new branch at its own main worktree HEAD', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', pathExists: nothingExists,
      members: [
        { repository: api, topology: [worktree('/ws/services/api', 'refs/heads/main', 'a'.repeat(40))], branchOid: null, fromOid: null },
        { repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: null, fromOid: null },
      ],
    });
    expect(decision).toMatchObject({
      outcome: 'plan',
      members: [
        { position: 0, startOid: 'a'.repeat(40), branchExisted: false, plan: { path: '/ws/api-feat-auth', createsBranch: true, startPoint: 'a'.repeat(40) } },
        { position: 1, startOid: 'b'.repeat(40), branchExisted: false, plan: { path: '/ws/web-feat-auth', createsBranch: true, startPoint: 'b'.repeat(40) } },
      ],
    });
  });

  test('an existing branch is checked out and its current OID recorded', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', pathExists: nothingExists,
      members: [{ repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: 'c'.repeat(40), fromOid: null }],
    });
    expect(decision).toMatchObject({ outcome: 'plan', members: [{ startOid: 'c'.repeat(40), branchExisted: true, plan: { createsBranch: false, startPoint: null } }] });
  });

  test('every member is planned, and every refusal is reported before anything is written', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', from: 'release',
      pathExists: (path) => path === '/ws/worker-feat-auth',
      members: [
        { repository: api, topology: [worktree('/ws/services/api', 'refs/heads/main', 'a'.repeat(40))], branchOid: null, fromOid: 'd'.repeat(40) },
        { repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: null, fromOid: null },
        { repository: worker, topology: [worktree('/ws/worker', 'refs/heads/main', 'e'.repeat(40))], branchOid: null, fromOid: 'f'.repeat(40) },
      ],
    });
    expect(decision.outcome).toBe('refused');
    if (decision.outcome !== 'refused') return;
    expect(decision.errors.map((error) => [error.code, error.context?.['repository']])).toEqual([
      ['WTM_CONFIG_INVALID', '/ws/web'],
      ['WTM_WORKTREE_PATH_OCCUPIED', '/ws/worker'],
    ]);
  });
});

describe('resolveCommit', () => {
  test('answers an OID for a commit-ish and null for a name that is not one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-resolve-commit-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'WTM Test');
      git('config', 'user.email', 'wtm-test@example.invalid');
      writeFileSync(join(root, 'README.md'), 'x\n');
      git('add', 'README.md');
      git('commit', '-m', 'x');
      const head = git('rev-parse', 'HEAD');
      expect([
        await resolveCommit(root, 'refs/heads/main'),
        await resolveCommit(root, 'refs/heads/absent'),
        await resolveCommit(root, '--help'),
      ]).toEqual([head, null, null]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature.test.ts`
Expected: FAIL (module `../create-feature` not found).

- [ ] **Step 3: Implement**

`packages/core/src/analysis/create-feature.ts`:

```ts
import { basename, resolve } from 'node:path';
import type { WtmError } from '@wtm/protocol';
import { resolveRepoScope } from '../config/repos';
import type { WtmConfig } from '../config/schema';
import { runGit } from '../git/git-runner';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type { RepositoryRecord } from '../state/store';
import { planWorktreeCreation, type WorktreeCreationPlan } from './create-worktree';

export type FeatureMemberResolution =
  | { outcome: 'resolved'; repositories: RepositoryRecord[] }
  | { outcome: 'refused'; error: WtmError };

/**
 * The repositories `--repos` names, in ascending id order, which is also the lease order.
 *
 * A `[repos.<name>]` entry names its repository; a repository with no entry answers to its main
 * root's directory name. A repository an entry names is not also reachable by its directory name,
 * so one repository never has two spellings.
 */
export function resolveFeatureMembers(input: {
  config: WtmConfig;
  workspaceRoot: string;
  repositories: readonly RepositoryRecord[];
  names: readonly string[];
}): FeatureMemberResolution {
  const names = [...new Set(input.names.map((name) => name.trim()).filter((name) => name.length > 0))];
  const named = input.repositories.map((repository) => ({
    repository,
    scopeName: resolveRepoScope(input.config, { workspaceRoot: input.workspaceRoot, repoRoot: repository.mainRoot })?.name ?? null,
    directory: basename(resolve(repository.mainRoot)),
  }));
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const chosen = new Map<string, RepositoryRecord>();
  for (const name of names) {
    const byEntry = named.filter((entry) => entry.scopeName === name);
    const matches = byEntry.length > 0
      ? byEntry
      : named.filter((entry) => entry.scopeName === null && entry.directory === name);
    if (matches.length === 0) unknown.push(name);
    else if (matches.length > 1) ambiguous.push(name);
    else chosen.set(matches[0]!.repository.id, matches[0]!.repository);
  }
  if (names.length === 0 || unknown.length > 0 || ambiguous.length > 0) {
    const reasons = [
      ...(names.length === 0 ? ['--repos names no repository.'] : []),
      ...(unknown.length > 0 ? [`--repos names no repository of this workspace: ${unknown.join(', ')}.`] : []),
      ...(ambiguous.length > 0 ? [`--repos names more than one repository: ${ambiguous.join(', ')}.`] : []),
    ];
    return {
      outcome: 'refused',
      error: {
        code: 'WTM_CONFIG_INVALID',
        message: reasons.join(' '),
        severity: 'error',
        context: { unknown, ambiguous, known: named.map((entry) => entry.scopeName ?? entry.directory).sort() },
      },
    };
  }
  return { outcome: 'resolved', repositories: [...chosen.values()].sort((left, right) => compare(left.id, right.id)) };
}

export interface FeatureMemberMeasurement {
  repository: RepositoryRecord;
  topology: readonly GitWorktreeRecord[];
  /** `refs/heads/<branch>`'s commit, or null when the branch does not exist. */
  branchOid: string | null;
  /** The commit `--from` names in this repository, or null when not given or unresolvable. */
  fromOid: string | null;
}

export interface FeatureMemberPlan {
  repository: RepositoryRecord;
  /** Index in the measured order, which is the lease order. */
  position: number;
  /** For a new branch, `startPoint` is the pinned OID rather than the ref that named it. */
  plan: WorktreeCreationPlan;
  startOid: string;
  branchExisted: boolean;
}

export type FeatureCreationDecision =
  | { outcome: 'plan'; members: FeatureMemberPlan[] }
  | { outcome: 'refused'; errors: WtmError[] };

/**
 * What a multi-repository create would do in every member, or every reason it will not.
 *
 * Pure, like `planWorktreeCreation`, which it runs once per member. Start points are pinned to
 * commit OIDs here, because the same branch name in two repositories is not the same commit and a
 * ref resolved later could have moved.
 */
export function planFeatureCreation(input: {
  workspaceRoot: string;
  branch: string;
  from?: string | undefined;
  members: readonly FeatureMemberMeasurement[];
  pathExists: (path: string) => boolean;
}): FeatureCreationDecision {
  const errors: WtmError[] = [];
  const members: FeatureMemberPlan[] = [];
  input.members.forEach((measurement, position) => {
    const repositoryContext = { repositoryId: measurement.repository.id, repository: measurement.repository.mainRoot };
    const decision = planWorktreeCreation({
      workspaceRoot: input.workspaceRoot,
      mainRoot: measurement.repository.mainRoot,
      branch: input.branch,
      topology: measurement.topology,
      branchExists: measurement.branchOid !== null,
      pathExists: input.pathExists,
      ...(input.from === undefined ? {} : { from: input.from }),
    });
    if (decision.outcome === 'refused') {
      errors.push({ ...decision.error, context: { ...(decision.error.context ?? {}), ...repositoryContext } });
      return;
    }
    const branchExisted = measurement.branchOid !== null;
    const startOid = branchExisted
      ? measurement.branchOid
      : input.from !== undefined ? measurement.fromOid : measurement.topology[0]?.head ?? null;
    if (startOid === null) {
      errors.push({
        code: 'WTM_CONFIG_INVALID',
        message: input.from !== undefined
          ? `--from ${input.from} does not name a commit in ${measurement.repository.mainRoot}.`
          : `${measurement.repository.mainRoot} has no main worktree HEAD to start ${decision.plan.branch} at.`,
        severity: 'error',
        context: { ...repositoryContext, ...(input.from === undefined ? {} : { from: input.from }) },
      });
      return;
    }
    members.push({
      repository: measurement.repository,
      position,
      startOid,
      branchExisted,
      plan: branchExisted ? decision.plan : { ...decision.plan, startPoint: startOid },
    });
  });
  return errors.length > 0 ? { outcome: 'refused', errors } : { outcome: 'plan', members };
}

/**
 * The commit `ref` names in `repoPath`, or null when it names none.
 *
 * `--end-of-options` keeps a ref that starts with `-` from being read as an option.
 */
export async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  const result = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    acceptedExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
```

In `packages/core/src/index.ts`, add:

```ts
export { planFeatureCreation, resolveCommit, resolveFeatureMembers } from './analysis/create-feature';
export type {
  FeatureCreationDecision,
  FeatureMemberMeasurement,
  FeatureMemberPlan,
  FeatureMemberResolution,
} from './analysis/create-feature';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature.test.ts packages/core/src/analysis/__tests__/create-worktree.test.ts`
Expected: PASS. If `git rev-parse` exits with a code other than 0 or 1 for `--help^{commit}` on the installed Git, add that code to `acceptedExitCodes` and keep the `null` answer.

- [ ] **Step 5: Typecheck, lint and commit**

Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add packages/core/src/analysis/create-feature.ts packages/core/src/index.ts packages/core/src/analysis/__tests__/create-feature.test.ts
git commit -m "feat: resolve --repos and plan every member with pinned start commits (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Classify a journalled member for `--resume`

**Files:**
- Create: `packages/core/src/analysis/create-feature-recovery.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/analysis/__tests__/create-feature-recovery.test.ts`

**Interfaces:**
- Consumes: `FeatureCreationMemberRecord` (Task 2); `WorktreeCreationPlan`, `GitWorktreeRecord` (existing).
- Produces (exported from `@wtm/core`):

```ts
export type MemberRecoveryAction =
  | { action: 'skip' }
  | { action: 'mark-applied'; worktree: GitWorktreeRecord }
  | { action: 'apply'; plan: WorktreeCreationPlan }
  | { action: 'refuse'; error: WtmError };
export interface MemberRecoveryInput {
  member: FeatureCreationMemberRecord;
  branch: string; // short name, e.g. feat/auth
  repositoryRegistered: boolean;
  topology: readonly GitWorktreeRecord[];
  branchOid: string | null;
  pathExists: boolean;
}
export function classifyMemberRecovery(input: MemberRecoveryInput): MemberRecoveryAction;
```

- [ ] **Step 1: Write the failing table-driven test**

`packages/core/src/analysis/__tests__/create-feature-recovery.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import type { FeatureCreationMemberRecord, FeatureCreationPhase } from '../../state/store';
import { classifyMemberRecovery, type MemberRecoveryInput } from '../create-feature-recovery';

const start = 'a'.repeat(40);
const moved = 'b'.repeat(40);
const path = '/ws/web-feat-auth';

const member = (phase: FeatureCreationPhase, branchExisted = false): FeatureCreationMemberRecord => ({
  creationId: 'c', repositoryId: 'r', repositoryMainRoot: '/ws/web', position: 0, worktreePath: path,
  branchExisted, startOid: start, phase, lastErrorCode: null, updatedAt: '2026-09-13T00:00:00.000Z',
});
const record = (at: string, branch: string | null, prunableReason: string | null = null): GitWorktreeRecord => ({
  path: at, head: start, branch, detached: branch === null, bare: false, lockedReason: null, prunableReason,
});
const main = record('/ws/web', 'refs/heads/main');
const input = (overrides: Partial<MemberRecoveryInput>): MemberRecoveryInput => ({
  member: member('APPLYING'), branch: 'feat/auth', repositoryRegistered: true,
  topology: [main], branchOid: null, pathExists: false, ...overrides,
});

describe('classifyMemberRecovery', () => {
  const cases: Array<[string, MemberRecoveryInput, unknown]> = [
    ['a forgotten repository is refused, by name', input({ repositoryRegistered: false }),
      { action: 'refuse', error: { code: 'WTM_CONFIG_INVALID', context: { repository: '/ws/web' } } }],
    ['a registered member is skipped', input({ member: member('REGISTERED') }), { action: 'skip' }],
    ['a worktree already on the branch at the path was applied, whatever the journal says',
      input({ topology: [main, record(path, 'refs/heads/feat/auth')], pathExists: true }),
      { action: 'mark-applied', worktree: { path, branch: 'refs/heads/feat/auth' } }],
    ['a stale Git entry at the path is refused with git worktree prune',
      input({ topology: [main, record(path, 'refs/heads/feat/auth', 'gitdir file points to non-existent location')] }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED', remediation: [{ kind: 'command-suggestion', argv: ['git', '-C', '/ws/web', 'worktree', 'prune'] }] } }],
    ['a worktree on another branch at the path is refused',
      input({ topology: [main, record(path, 'refs/heads/other')], pathExists: true }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED' } }],
    ['the branch checked out elsewhere is refused',
      input({ topology: [main, record('/elsewhere', 'refs/heads/feat/auth')], branchOid: start }),
      { action: 'refuse', error: { code: 'GIT_BRANCH_IN_USE', context: { worktreePath: '/elsewhere' } } }],
    ['something at the path that is not a worktree is refused', input({ pathExists: true }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED' } }],
    ['nothing written yet: the branch is created at the pinned commit', input({}),
      { action: 'apply', plan: { path, branch: 'feat/auth', branchRef: 'refs/heads/feat/auth', createsBranch: true, startPoint: start } }],
    ['an applied member whose worktree is gone converges again', input({ member: member('APPLIED') }),
      { action: 'apply', plan: { createsBranch: true, startPoint: start } }],
    ['a branch this creation made before worktree add failed is checked out', input({ branchOid: start }),
      { action: 'apply', plan: { createsBranch: false, startPoint: null } }],
    ['a branch that existed before the creation is checked out even if it moved',
      input({ member: member('PLANNED', true), branchOid: moved }),
      { action: 'apply', plan: { createsBranch: false, startPoint: null } }],
    ['a branch this creation did not make, at another commit, is refused', input({ branchOid: moved }),
      { action: 'refuse', error: { code: 'GIT_BRANCH_IN_USE', context: { branchOid: moved, startOid: start } } }],
  ];

  for (const [name, given, expected] of cases) {
    test(name, () => {
      expect(classifyMemberRecovery(given)).toMatchObject(expected as object);
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature-recovery.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/analysis/create-feature-recovery.ts`:

```ts
import { resolve } from 'node:path';
import type { Remediation, WtmError } from '@wtm/protocol';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type { FeatureCreationMemberRecord } from '../state/store';
import type { WorktreeCreationPlan } from './create-worktree';

export type MemberRecoveryAction =
  | { action: 'skip' }
  | { action: 'mark-applied'; worktree: GitWorktreeRecord }
  | { action: 'apply'; plan: WorktreeCreationPlan }
  | { action: 'refuse'; error: WtmError };

export interface MemberRecoveryInput {
  member: FeatureCreationMemberRecord;
  /** The short branch name, e.g. `feat/auth`. */
  branch: string;
  repositoryRegistered: boolean;
  topology: readonly GitWorktreeRecord[];
  branchOid: string | null;
  pathExists: boolean;
}

/**
 * What `--resume` does with one journalled member (spec §4).
 *
 * The recorded phase is a hint, not an instruction: a crash can leave `APPLYING` on a member Git
 * finished, or on one it never started. Observed state decides. Anything that is neither the
 * requested state nor provably safe to reach is refused with what was found, and nothing is
 * deleted.
 */
export function classifyMemberRecovery(input: MemberRecoveryInput): MemberRecoveryAction {
  const { member } = input;
  const branchRef = `refs/heads/${input.branch}`;
  const context = {
    repositoryId: member.repositoryId,
    repository: member.repositoryMainRoot,
    path: member.worktreePath,
    branch: input.branch,
    phase: member.phase,
  };

  if (!input.repositoryRegistered) {
    return refuse('WTM_CONFIG_INVALID',
      `${member.repositoryMainRoot} is part of this creation but is no longer registered with WTM. `
      + 'Register it again with `wtm init`, then resume.', context);
  }
  if (member.phase === 'REGISTERED') return { action: 'skip' };

  const atPath = input.topology.find((record) => resolve(record.path) === resolve(member.worktreePath));
  if (atPath !== undefined) {
    if (atPath.prunableReason !== null) {
      return refuse('WTM_WORKTREE_PATH_OCCUPIED',
        `Git still records a worktree at ${member.worktreePath} that is gone (${atPath.prunableReason}). `
        + `Run \`git worktree prune\` in ${member.repositoryMainRoot}, then resume.`,
        context, [{ kind: 'command-suggestion', argv: ['git', '-C', member.repositoryMainRoot, 'worktree', 'prune'] }]);
    }
    if (atPath.branch === branchRef) return { action: 'mark-applied', worktree: atPath };
    return refuse('WTM_WORKTREE_PATH_OCCUPIED',
      `${member.worktreePath} is a worktree on ${atPath.branch ?? 'a detached HEAD'}, not on ${input.branch}.`,
      { ...context, foundBranch: atPath.branch });
  }

  const holder = input.topology.find((record) => record.branch === branchRef);
  if (holder !== undefined) {
    return refuse('GIT_BRANCH_IN_USE',
      `${input.branch} is checked out in ${holder.path}, not at ${member.worktreePath}.`,
      { ...context, worktreePath: holder.path });
  }
  if (input.pathExists) {
    return refuse('WTM_WORKTREE_PATH_OCCUPIED',
      `${member.worktreePath} exists but is not a worktree of ${member.repositoryMainRoot}. Move or remove it, then resume.`,
      context);
  }

  const base = { path: member.worktreePath, branch: input.branch, branchRef };
  if (input.branchOid === null) {
    return { action: 'apply', plan: { ...base, createsBranch: true, startPoint: member.startOid } };
  }
  if (member.branchExisted || input.branchOid === member.startOid) {
    return { action: 'apply', plan: { ...base, createsBranch: false, startPoint: null } };
  }
  return refuse('GIT_BRANCH_IN_USE',
    `${input.branch} points at ${input.branchOid}, not at ${member.startOid} where this creation started it, `
    + 'so it is not the branch this creation made.',
    { ...context, branchOid: input.branchOid, startOid: member.startOid });
}

function refuse(
  code: 'WTM_CONFIG_INVALID' | 'WTM_WORKTREE_PATH_OCCUPIED' | 'GIT_BRANCH_IN_USE',
  message: string,
  context: Record<string, unknown>,
  remediation?: readonly Remediation[],
): MemberRecoveryAction {
  return {
    action: 'refuse',
    error: { code, message, severity: 'error', context, ...(remediation === undefined ? {} : { remediation: [...remediation] }) },
  };
}
```

In `packages/core/src/index.ts`, add:

```ts
export { classifyMemberRecovery } from './analysis/create-feature-recovery';
export type { MemberRecoveryAction, MemberRecoveryInput } from './analysis/create-feature-recovery';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature-recovery.test.ts`
Expected: PASS (12 cases).

- [ ] **Step 5: Typecheck, lint and commit**

Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add packages/core/src/analysis/create-feature-recovery.ts packages/core/src/index.ts packages/core/src/analysis/__tests__/create-feature-recovery.test.ts
git commit -m "feat: classify a journalled creation member against observed Git state (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `wtm create --repos` command, wiring and `docs/04`

**Files:**
- Modify: `packages/cli/src/commands/create.ts` (export helpers)
- Create: `packages/cli/src/commands/create-feature.ts`
- Modify: `packages/cli/src/main.ts` (options, dependency seam, dispatch)
- Modify: `docs/04-cli-reference.md` (`wtm create` section)
- Create: `packages/cli/src/__tests__/create-feature.scenario.ts`
- Create: `packages/cli/src/__tests__/create-feature.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5 exports from `@wtm/core`; existing `createWorktree`, `listGitWorktrees`, `resolveWorkspaceConfig`, `containsPath`, `SQLiteStateStore`, `RepositoryOperationConflictError`.
- Produces:

```ts
// packages/cli/src/commands/create.ts (now exported)
export function notInitialized(): WtmError;
export function gitFailure(error: unknown): WtmError;
export function message(error: unknown): string;
export async function reconciledByDaemon(client: RuntimeDaemonClient | undefined): Promise<boolean>;

// packages/cli/src/commands/create-feature.ts
export interface FeatureCreateCommandInput {
  cwd: string; branch: string; repos?: readonly string[] | undefined; from?: string | undefined;
  resume: boolean; databasePath: string; globalConfigPath: string;
  client?: RuntimeDaemonClient | undefined;
  readProcessStartTime: ProcessStartTimeReader; hostId: string;
  applyWorktree?: ((repoPath: string, plan: WorktreeCreationPlan) => Promise<GitWorktreeRecord>) | undefined;
}
export interface FeatureCreateMemberData {
  repository: { id: string; mainRoot: string };
  worktree: { path: string; branch: string | null; head: string | null } | null;
  branch: { name: string; created: boolean; startPoint: string };
  phase: FeatureCreationPhase;
  recoveredFrom?: FeatureCreationPhase;
}
export interface FeatureCreateCommandData {
  feature: { id: string; branch: string };
  members: FeatureCreateMemberData[];
  registration: CreateRegistration | null;
  resumed: boolean;
}
export function runFeatureCreateCommand(input: FeatureCreateCommandInput): Promise<JsonEnvelope<FeatureCreateCommandData | null>>;

// packages/cli/src/main.ts, CliDependencies
featureCreateApply?: (repoPath: string, plan: WorktreeCreationPlan) => Promise<GitWorktreeRecord>;
```

- [ ] **Step 1: Write the failing scenario and test**

`packages/cli/src/__tests__/create-feature.scenario.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDependencies } from '../main';

/**
 * `wtm create --repos` against a real workspace of three repositories registered by `wtm init`.
 * Recovery (`--resume`) has its own scenario; this one covers creation, pre-flight and conflicts.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-create-feature-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const socketPath = join(root, 'd.sock');
const workspaceRoot = join(root, 'ws');
const gitConfig = join(root, 'gitconfig');
const repos = ['web', 'api', 'worker'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Invocation {
  code: number;
  stderr: string;
  envelope: { ok: boolean; data: any; warnings: Array<{ code: string }>; errors: Array<{ code: string; context?: Record<string, unknown>; remediation?: unknown }> };
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}): Promise<Invocation> {
  const { runCli } = await import('../main');
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    cwd: workspaceRoot,
    analysisDatabasePath: databasePath,
    diagnosticsDatabasePath: databasePath,
    removalGlobalConfigPath: join(dataRoot, 'config.toml'),
    daemonSocketPath: socketPath,
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: (value) => { err += value; },
  });
  return { code, stderr: err, envelope: JSON.parse(out) };
}

const create = (...argv: string[]) => invoke(['create', ...argv, '--json']);
const branchExists = (repo: string, branch: string) => {
  try { git(join(workspaceRoot, repo), 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; }
};

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';

const heads: Record<string, string> = {};
for (const repo of repos) {
  const path = join(workspaceRoot, repo);
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'WTM Create');
  git(path, 'config', 'user.email', 'wtm-create@example.invalid');
  // Different content per repository, so each has its own HEAD and the pinning is observable.
  await writeFile(join(path, 'README.md'), `${repo}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', repo);
  heads[repo] = git(path, 'rev-parse', 'HEAD').trim();
}

const reconcileOk = { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never;
const initialized = await invoke(['init', '--yes', '--json'], { initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk });
if (initialized.code !== 0) throw new Error(`wtm init failed: ${initialized.stderr}`);

const created = await create('feat/auth', '--repos', 'web,api,worker');
const statusInside = await invoke(['status', '--json'], { cwd: join(workspaceRoot, 'api-feat-auth') });

const unknownName = await create('feat/unknown', '--repos', 'web,nope');

await mkdir(join(workspaceRoot, 'worker-feat-blocked'), { recursive: true });
const blocked = await create('feat/blocked', '--repos', 'web,api,worker');

const daemon = await invoke(['create', 'feat/daemon', '--repos', 'web,api', '--json'], { runtimeClient: reconcileOk });

const noRepos = await create('feat/nothing', '--resume');

process.stdout.write(JSON.stringify({
  created: {
    exitCode: created.code,
    ok: created.envelope.ok,
    featureBranch: created.envelope.data?.feature?.branch ?? null,
    featureId: typeof created.envelope.data?.feature?.id === 'string',
    registration: created.envelope.data?.registration ?? null,
    resumed: created.envelope.data?.resumed ?? null,
    warnings: created.envelope.warnings.map(({ code }) => code),
    members: (created.envelope.data?.members ?? []).map((member: any) => ({
      repository: member.repository.mainRoot.split(/[\\/]/).pop(),
      path: member.worktree?.path ?? null,
      phase: member.phase,
      created: member.branch.created,
      startPointIsOwnHead: member.branch.startPoint === heads[member.repository.mainRoot.split(/[\\/]/).pop()],
    })).sort((left: any, right: any) => left.repository.localeCompare(right.repository)),
    onDisk: repos.map((repo) => existsSync(join(workspaceRoot, `${repo}-feat-auth`))),
    expectedPaths: repos.map((repo) => join(workspaceRoot, `${repo}-feat-auth`)).sort(),
  },
  statusInside: {
    exitCode: statusInside.code,
    registered: (statusInside.envelope.data?.workspaces?.[0]?.identity?.worktreeId ?? null) !== null,
  },
  unknownName: {
    code: unknownName.envelope.errors[0]?.code ?? null,
    unknown: unknownName.envelope.errors[0]?.context?.['unknown'] ?? null,
    webCreated: existsSync(join(workspaceRoot, 'web-feat-unknown')),
  },
  blocked: {
    ok: blocked.envelope.ok,
    codes: blocked.envelope.errors.map(({ code }) => code),
    nothingWritten: !existsSync(join(workspaceRoot, 'web-feat-blocked'))
      && !existsSync(join(workspaceRoot, 'api-feat-blocked'))
      && !branchExists('web', 'feat/blocked') && !branchExists('api', 'feat/blocked'),
  },
  daemon: { ok: daemon.envelope.ok, registration: daemon.envelope.data?.registration ?? null, warnings: daemon.envelope.warnings.map(({ code }) => code) },
  noRepos: { code: noRepos.envelope.errors[0]?.code ?? null },
}));
```

`packages/cli/src/__tests__/create-feature.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./create-feature.scenario.ts', import.meta.url));
let scenario: Record<string, any>;

beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as Record<string, any>;
});

describe('wtm create --repos', () => {
  test('creates one worktree per repository under one feature, from the workspace root', () => {
    expect(scenario['created']).toMatchObject({
      exitCode: 0, ok: true, featureBranch: 'refs/heads/feat/auth', featureId: true,
      registration: 'local', resumed: false, warnings: ['WTM_DAEMON_UNAVAILABLE'],
      onDisk: [true, true, true],
    });
    expect(scenario['created'].members.map((m: any) => m.path).sort()).toEqual(scenario['created'].expectedPaths);
  });

  test('every member is registered, created new, and started at its own repository HEAD', () => {
    for (const member of scenario['created'].members) {
      expect(member).toMatchObject({ phase: 'REGISTERED', created: true, startPointIsOwnHead: true });
    }
    expect(scenario['statusInside']).toEqual({ exitCode: 0, registered: true });
  });

  test('an unknown repository name is refused before anything is written', () => {
    expect(scenario['unknownName']).toEqual({ code: 'WTM_CONFIG_INVALID', unknown: ['nope'], webCreated: false });
  });

  test('one member refused by pre-flight refuses the whole creation and writes nothing', () => {
    expect(scenario['blocked']).toEqual({ ok: false, codes: ['WTM_WORKTREE_PATH_OCCUPIED'], nothingWritten: true });
  });

  test('a daemon that answers the reconcile registers the members', () => {
    expect(scenario['daemon']).toEqual({ ok: true, registration: 'daemon', warnings: [] });
  });

  test('--resume with nothing to resume is refused', () => {
    expect(scenario['noRepos']).toEqual({ code: 'WTM_CONFIG_INVALID' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/create-feature.test.ts`
Expected: FAIL (`unknown option '--repos'`, so the scenario's `JSON.parse` of the usage output throws or the envelope is a usage failure).

- [ ] **Step 3: Export the shared helpers from `create.ts`**

In `packages/cli/src/commands/create.ts`, add `export` to `reconciledByDaemon`, `notInitialized`, `gitFailure` and `message`. Nothing else changes.

- [ ] **Step 4: Implement the command**

`packages/cli/src/commands/create-feature.ts`:

```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import {
  classifyMemberRecovery,
  containsPath,
  createWorktree,
  listGitWorktrees,
  planFeatureCreation,
  RepositoryOperationConflictError,
  resolveCommit,
  resolveFeatureMembers,
  resolveWorkspaceConfig,
  SQLiteStateStore,
  withRepositoryOperationLeases,
} from '@wtm/core';
import type {
  FeatureCreationPhase,
  FeatureCreationRecord,
  FeatureMemberMeasurement,
  GitWorktreeRecord,
  ProcessStartTimeReader,
  RepositoryOperationLeasesSession,
  RepositoryRecord,
  WorkspaceRecord,
  WorktreeCreationPlan,
} from '@wtm/core';
import { gitFailure, message, notInitialized, reconciledByDaemon, type CreateRegistration } from './create';
import type { RuntimeDaemonClient } from './runtime-client';

export interface FeatureCreateCommandInput {
  cwd: string;
  branch: string;
  /** `--repos`, split on commas. Required unless `resume`. */
  repos?: readonly string[] | undefined;
  from?: string | undefined;
  resume: boolean;
  databasePath: string;
  globalConfigPath: string;
  client?: RuntimeDaemonClient | undefined;
  readProcessStartTime: ProcessStartTimeReader;
  hostId: string;
  /** Test seam for the Git write. Defaults to `createWorktree`. */
  applyWorktree?: ((repoPath: string, plan: WorktreeCreationPlan) => Promise<GitWorktreeRecord>) | undefined;
}

export interface FeatureCreateMemberData {
  repository: { id: string; mainRoot: string };
  worktree: { path: string; branch: string | null; head: string | null } | null;
  branch: { name: string; created: boolean; startPoint: string };
  phase: FeatureCreationPhase;
  recoveredFrom?: FeatureCreationPhase;
}

export interface FeatureCreateCommandData {
  feature: { id: string; branch: string };
  members: FeatureCreateMemberData[];
  registration: CreateRegistration | null;
  resumed: boolean;
}

type Envelope = JsonEnvelope<FeatureCreateCommandData | null>;

interface MemberWork {
  repository: RepositoryRecord;
  /** The Git write still to do, or null when there is none. */
  plan: WorktreeCreationPlan | null;
  /** A worktree that already exists for this member. */
  worktree: GitWorktreeRecord | null;
  alreadyRegistered: boolean;
}

/**
 * `wtm create <branch> --repos …` and `wtm create <branch> --resume` (spec
 * 2026-09-13-multi-repo-create-design.md).
 */
export async function runFeatureCreateCommand(input: FeatureCreateCommandInput): Promise<Envelope> {
  if (!existsSync(input.databasePath)) return failure([notInitialized()]);
  let store: SQLiteStateStore;
  try {
    store = new SQLiteStateStore(input.databasePath);
  } catch {
    return failure([notInitialized()]);
  }
  try {
    const branch = shortBranch(input.branch);
    const workspace = workspaceContaining(store, input.cwd);
    if (workspace === undefined) return failure([notInitialized()]);
    const repositories = store.listRepositories(workspace.id);
    const open = store.readOpenFeatureCreation(workspace.id, `refs/heads/${branch}`);
    return input.resume
      ? await resume(input, store, workspace, repositories, branch, open)
      : await createFresh(input, store, workspace, repositories, branch, open);
  } catch (error) {
    if (error instanceof RepositoryOperationConflictError) {
      return failure([{
        code: error.code, message: error.message, severity: error.severity,
        context: { ...error.context }, remediation: [...error.remediation],
      }]);
    }
    return failure([gitFailure(error)]);
  } finally {
    store.close();
  }
}

async function createFresh(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  workspace: WorkspaceRecord,
  repositories: readonly RepositoryRecord[],
  branch: string,
  open: FeatureCreationRecord | null,
): Promise<Envelope> {
  if (input.repos === undefined) {
    return failure([configInvalid('--repos names the repositories to create the feature in.', { branch })]);
  }
  const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
  const resolution = resolveFeatureMembers({ config: config.value, workspaceRoot: workspace.root, repositories, names: input.repos });
  if (resolution.outcome === 'refused') return failure([resolution.error]);

  // An open creation that wrote nothing may be replaced; one that wrote anything must be resumed.
  let supersedeCreationId: string | undefined;
  if (open !== null) {
    if (!open.members.every((member) => member.phase === 'PLANNED')) return failure([openCreationConflict(branch, open)]);
    supersedeCreationId = open.id;
  }

  const planInput = { workspaceRoot: workspace.root, branch, from: input.from, pathExists: existsSync };
  const first = planFeatureCreation({ ...planInput, members: await measure(resolution.repositories, branch, input.from) });
  if (first.outcome === 'refused') return failure(first.errors);

  return await withRepositoryOperationLeases({
    store,
    readProcessStartTime: input.readProcessStartTime,
    hostId: input.hostId,
    repositoryIds: resolution.repositories.map(({ id }) => id),
    operation: 'create',
  }, async (leases) => {
    // Measured again under the leases: a branch checked out or a path filled since planning is
    // refused here, before the journal exists and before Git writes.
    const second = planFeatureCreation({ ...planInput, members: await measure(resolution.repositories, branch, input.from) });
    if (second.outcome === 'refused') return failure(second.errors);
    const creation = store.beginFeatureCreation({
      workspaceId: workspace.id,
      branch: `refs/heads/${branch}`,
      fromRef: input.from ?? null,
      members: second.members.map((member) => ({
        repositoryId: member.repository.id,
        repositoryMainRoot: member.repository.mainRoot,
        position: member.position,
        worktreePath: member.plan.path,
        branchExisted: member.branchExisted,
        startOid: member.startOid,
      })),
      ...(supersedeCreationId === undefined ? {} : { supersedeCreationId }),
    });
    const work = second.members.map((member): MemberWork => ({
      repository: member.repository, plan: member.plan, worktree: null, alreadyRegistered: false,
    }));
    return await applyAndRegister(input, store, leases, creation, branch, work, false, new Map());
  });
}

async function resume(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  workspace: WorkspaceRecord,
  repositories: readonly RepositoryRecord[],
  branch: string,
  open: FeatureCreationRecord | null,
): Promise<Envelope> {
  if (open === null) {
    return failure([configInvalid(`There is no unfinished creation of ${branch} in this workspace to resume.`, { branch })]);
  }
  if (input.from !== undefined) {
    return failure([configInvalid('--from cannot be combined with --resume: the start commits were pinned when the creation began.', { branch, from: input.from })]);
  }
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  if (input.repos !== undefined) {
    const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
    const resolution = resolveFeatureMembers({ config: config.value, workspaceRoot: workspace.root, repositories, names: input.repos });
    if (resolution.outcome === 'refused') return failure([resolution.error]);
    const given = resolution.repositories.map(({ id }) => id).sort();
    const journalled = open.members.map(({ repositoryId }) => repositoryId).sort();
    if (given.join('\n') !== journalled.join('\n')) {
      return failure([configInvalid('--repos does not match the creation being resumed.', {
        branch,
        given: resolution.repositories.map(({ mainRoot }) => mainRoot),
        journalled: open.members.map(({ repositoryMainRoot }) => repositoryMainRoot),
      })]);
    }
  }
  // Before any lease: the lease table's foreign key would reject a lease on a forgotten repository.
  const forgotten = open.members.filter((member) => !byId.has(member.repositoryId));
  if (forgotten.length > 0) {
    return failure(forgotten.map((member) => {
      const action = classifyMemberRecovery({ member, branch, repositoryRegistered: false, topology: [], branchOid: null, pathExists: false });
      return action.action === 'refuse' ? action.error : configInvalid('A member repository is no longer registered.', { branch });
    }));
  }

  return await withRepositoryOperationLeases({
    store,
    readProcessStartTime: input.readProcessStartTime,
    hostId: input.hostId,
    repositoryIds: open.members.map(({ repositoryId }) => repositoryId),
    operation: 'create',
    adopt: true,
  }, async (leases) => {
    const recovered = new Map<string, FeatureCreationPhase>();
    const existing = new Map<string, GitWorktreeRecord>();
    const work: MemberWork[] = [];
    for (const member of open.members) {
      const repository = byId.get(member.repositoryId)!;
      const topology = await listGitWorktrees(repository.mainRoot);
      const action = classifyMemberRecovery({
        member, branch, repositoryRegistered: true, topology,
        branchOid: await resolveCommit(repository.mainRoot, `refs/heads/${branch}`),
        pathExists: existsSync(member.worktreePath),
      });
      if (action.action === 'refuse') {
        return failure([action.error], envelopeData(store, open.id, existing, null, true, recovered));
      }
      recovered.set(member.repositoryId, member.phase);
      if (action.action === 'skip') {
        const at = topology.find((record) => resolve(record.path) === resolve(member.worktreePath));
        if (at !== undefined) existing.set(member.repositoryId, at);
        work.push({ repository, plan: null, worktree: at ?? null, alreadyRegistered: true });
      } else if (action.action === 'mark-applied') {
        store.advanceCreationMember(open.id, member.repositoryId, 'APPLIED', null);
        work.push({ repository, plan: null, worktree: action.worktree, alreadyRegistered: false });
      } else {
        work.push({ repository, plan: action.plan, worktree: null, alreadyRegistered: false });
      }
    }
    return await applyAndRegister(input, store, leases, open, branch, work, true, recovered);
  });
}

async function applyAndRegister(
  input: FeatureCreateCommandInput,
  store: SQLiteStateStore,
  leases: RepositoryOperationLeasesSession,
  creation: FeatureCreationRecord,
  branch: string,
  work: readonly MemberWork[],
  resumed: boolean,
  recovered: ReadonlyMap<string, FeatureCreationPhase>,
): Promise<Envelope> {
  const apply = input.applyWorktree ?? createWorktree;
  const worktrees = new Map<string, GitWorktreeRecord>();
  for (const item of work) {
    if (item.worktree !== null) worktrees.set(item.repository.id, item.worktree);
    if (item.plan === null) continue;
    const plan = item.plan;
    leases.renewAll();
    store.advanceCreationMember(creation.id, item.repository.id, 'APPLYING', null);
    try {
      const record = await apply(item.repository.mainRoot, plan);
      if (plan.createsBranch && record.head !== plan.startPoint) {
        throw new Error(`git worktree add started ${plan.branch} at ${String(record.head)}, not at the pinned ${String(plan.startPoint)}.`);
      }
      store.advanceCreationMember(creation.id, item.repository.id, 'APPLIED', null);
      worktrees.set(item.repository.id, record);
    } catch (error) {
      const cause = gitFailure(error);
      const after = await listGitWorktrees(item.repository.mainRoot).catch(() => null);
      // Only a topology that provably lacks the worktree returns the member to PLANNED. Anything
      // less leaves it APPLYING, and --resume inspects it instead of trusting either answer.
      if (after !== null && !after.some((record) => resolve(record.path) === resolve(plan.path))) {
        store.advanceCreationMember(creation.id, item.repository.id, 'PLANNED', cause.code);
      }
      return failure(
        [withResume({ ...cause, context: { ...(cause.context ?? {}), repository: item.repository.mainRoot, path: plan.path } }, branch)],
        envelopeData(store, creation.id, worktrees, null, resumed, recovered),
      );
    }
  }

  const registration: CreateRegistration = await reconciledByDaemon(input.client) ? 'daemon' : 'local';
  const failures: WtmError[] = [];
  for (const item of work) {
    if (item.alreadyRegistered) continue;
    if (registration === 'local') {
      try {
        store.reconcileWorktrees(item.repository.id, await listGitWorktrees(item.repository.mainRoot));
      } catch (error) {
        failures.push(withResume({
          code: 'GIT_REPOSITORY_DEGRADED',
          message: `The worktree in ${item.repository.mainRoot} was created but could not be registered: ${message(error)}`,
          severity: 'error',
          context: { repository: item.repository.mainRoot },
        }, branch));
        continue;
      }
    }
    store.advanceCreationMember(creation.id, item.repository.id, 'REGISTERED', null);
  }
  const warnings: WtmError[] = registration === 'local' ? [{
    code: 'WTM_DAEMON_UNAVAILABLE',
    message: 'The daemon is unreachable, so these worktrees were registered locally. Their '
      + '`worktree.created` tasks did not run and `[prepare] mode = "eager"` did not prepare their '
      + 'resources; the first task you run in each prepares them.',
    severity: 'warning',
    context: { paths: [...worktrees.values()].map(({ path }) => path) },
  }] : [];
  if (failures.length > 0) {
    return { ...failure(failures, envelopeData(store, creation.id, worktrees, registration, resumed, recovered)), warnings };
  }
  store.completeFeatureCreation(creation.id);
  return {
    schemaVersion: 1,
    ok: true,
    command: 'create',
    scope: { mode: 'local' },
    data: envelopeData(store, creation.id, worktrees, registration, resumed, recovered),
    warnings,
    errors: [],
  };
}

async function measure(repositories: readonly RepositoryRecord[], branch: string, from: string | undefined): Promise<FeatureMemberMeasurement[]> {
  return await Promise.all(repositories.map(async (repository) => ({
    repository,
    topology: await listGitWorktrees(repository.mainRoot),
    branchOid: await resolveCommit(repository.mainRoot, `refs/heads/${branch}`),
    fromOid: from === undefined ? null : await resolveCommit(repository.mainRoot, from),
  })));
}

/**
 * The workspace a multi-repository create is about: the one owning the registered worktree the
 * command runs in, or else the registered workspace whose root contains it, so the command also
 * works from the workspace root, which is no repository's worktree.
 */
function workspaceContaining(store: SQLiteStateStore, cwd: string): WorkspaceRecord | undefined {
  const absolute = resolve(cwd);
  const workspaces = store.listWorkspaces();
  const worktree = store.listWorktrees()
    .filter((candidate) => containsPath(candidate.path, absolute))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (worktree !== undefined) {
    const repository = store.listRepositories().find(({ id }) => id === worktree.repositoryId);
    const owner = workspaces.find(({ id }) => id === repository?.workspaceId);
    if (owner !== undefined) return owner;
  }
  return workspaces
    .filter((candidate) => containsPath(candidate.root, absolute))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function envelopeData(
  store: SQLiteStateStore,
  creationId: string,
  worktrees: ReadonlyMap<string, GitWorktreeRecord>,
  registration: CreateRegistration | null,
  resumed: boolean,
  recovered: ReadonlyMap<string, FeatureCreationPhase>,
): FeatureCreateCommandData {
  const record = store.readFeatureCreation(creationId)!;
  return {
    feature: { id: record.feature.id, branch: record.feature.branch },
    members: record.members.map((member) => {
      const worktree = worktrees.get(member.repositoryId) ?? null;
      const from = recovered.get(member.repositoryId);
      return {
        repository: { id: member.repositoryId, mainRoot: member.repositoryMainRoot },
        worktree: worktree === null ? null : { path: worktree.path, branch: worktree.branch, head: worktree.head },
        branch: { name: shortBranch(record.feature.branch), created: !member.branchExisted, startPoint: member.startOid },
        phase: member.phase,
        ...(from === undefined ? {} : { recoveredFrom: from }),
      };
    }),
    registration,
    resumed,
  };
}

function openCreationConflict(branch: string, open: FeatureCreationRecord): WtmError {
  return {
    code: 'WTM_OPERATION_CONFLICT',
    message: `A creation of ${branch} that started at ${open.createdAt} has not finished. Resume it instead of starting another.`,
    severity: 'error',
    context: {
      branch,
      creationId: open.id,
      members: open.members.map(({ repositoryMainRoot, phase }) => ({ repository: repositoryMainRoot, phase })),
    },
    remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', branch, '--resume'] }],
  };
}

function withResume(error: WtmError, branch: string): WtmError {
  return { ...error, remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', branch, '--resume'] }] };
}

function configInvalid(text: string, context: Record<string, unknown>): WtmError {
  return { code: 'WTM_CONFIG_INVALID', message: text, severity: 'error', context };
}

function shortBranch(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

function failure(errors: readonly WtmError[], data: FeatureCreateCommandData | null = null): Envelope {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'create',
    scope: { mode: 'local' },
    data,
    warnings: [],
    errors: [...errors],
  };
}
```

If `JsonEnvelope` requires a non-empty `errors` tuple when `ok` is false, build it as `[first, ...rest]` the way `diagnostics.ts`'s `failure` does.

- [ ] **Step 5: Wire the options in `main.ts`**

Add to the `@wtm/core` type imports: `GitWorktreeRecord` (if not already imported) and `WorktreeCreationPlan`. Add `import { runFeatureCreateCommand } from './commands/create-feature';` next to the `runCreateCommand` import.

Add to `CliDependencies`:

```ts
  /** Test seam: the Git write of a multi-repository create, so a scenario can make one member fail. */
  featureCreateApply?: (repoPath: string, plan: WorktreeCreationPlan) => Promise<GitWorktreeRecord>;
```

Replace the `create` command block with:

```ts
  const create = program
    .command('create <branch>')
    .description('Create one linked worktree for a branch, beside its repository.');
  addJsonOption(create);
  create.option('--from <ref>', 'start a new branch here instead of at the main worktree HEAD');
  create.option('--repos <names>', 'create the branch in each named repository of the workspace, as one feature');
  create.option('--resume', 'finish a multi-repository creation that did not complete');
  create.action(async (branch: string, options: ScopeOptions & { from?: string; repos?: string; resume?: boolean }) => {
    if (options.repos !== undefined || options.resume === true) {
      renderRuntime(await runFeatureCreateCommand({
        cwd,
        branch,
        ...(options.repos === undefined ? {} : { repos: options.repos.split(',') }),
        ...(options.from === undefined ? {} : { from: options.from }),
        resume: options.resume === true,
        databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
        globalConfigPath: dependencies.removalGlobalConfigPath ?? defaultProductionRuntimePaths().globalConfigPath,
        ...(dependencies.runtimeClient === undefined ? {} : { client: dependencies.runtimeClient }),
        // The CLI is the composition root that chooses the platform reader, as it does for remove.
        readProcessStartTime: (pid) => hostPlatformRuntime().process.readStartTime(pid),
        hostId: hostname(),
        ...(dependencies.featureCreateApply === undefined ? {} : { applyWorktree: dependencies.featureCreateApply }),
      }), runtimeJson(program, options));
      return;
    }
    renderRuntime(await runCreateCommand({
      cwd,
      branch,
      ...(options.from === undefined ? {} : { from: options.from }),
      databasePath: dependencies.analysisDatabasePath ?? defaultProductionRuntimePaths().databasePath,
      ...(dependencies.runtimeClient === undefined ? {} : { client: dependencies.runtimeClient }),
    }), runtimeJson(program, options));
  });
```

- [ ] **Step 6: Update `docs/04-cli-reference.md`**

In the `wtm create <branch>` section:

1. Add to the bash example block:

```bash
wtm create feat/auth --repos web,api,worker
wtm create feat/auth --resume
```

2. Add to the options block:

```text
--repos <names>  create the branch in each named repository of the workspace, as one feature
--resume         finish a multi-repository creation that did not complete
```

3. Replace the last two paragraphs (from "`create` takes no repository operation lease." to the end of the section) with:

```markdown
Without `--repos`, `create` takes no repository operation lease. Leases serialize the operations
that destroy (`remove`, `gc`, `repair`) and exclude the whole repository while held; creating one
worktree destroys nothing, so it neither takes one nor waits for one.

#### Several repositories: `--repos`

`wtm create feat/auth --repos web,api,worker` creates `feat/auth` in each named repository, as one
feature, and can run from the workspace root. A name is a `[repos.<name>]` entry, or the
repository directory's name when no entry names it. The worktrees share the feature the runtime
already groups by branch — ports and CORS work across them as before — and WTM records that
feature with a persistent id.

- Every member is checked before Git writes anything, and all refusals are reported together. An
  unknown or ambiguous name is `WTM_CONFIG_INVALID`.
- Each new branch starts at a commit pinned per repository: `--from`, or that repository's main
  worktree HEAD. The same branch name in two repositories is not the same commit.
- The command takes a `create` lease on every member, in a fixed order, and refuses rather than
  waits if any is held (`WTM_OPERATION_CONFLICT`). A queued or running `wtm run --enqueue` job does
  not block it.
- Each member is journalled. If a member fails, the ones already created stay, the command fails
  with a `wtm create <branch> --resume` remediation, and a new `create` of the same branch is
  refused until it is resumed. The one exception: if nothing was written to Git yet, a new
  `create` replaces the unfinished one.

`--resume` looks at each member's real Git state rather than trusting the journal: a worktree
already on the branch at the path counts as done, a member with nothing written is created at its
pinned commit, and anything else — a directory at the path, the branch checked out elsewhere or
pointing at another commit, a stale Git worktree entry, a forgotten repository — is refused with
what was found. `--from` cannot be combined with `--resume`, and a `--repos` given with it must
match the creation. WTM never deletes anything to make a creation fit.

The envelope reports `feature` (`id`, `branch`), `members[]` (repository, worktree, branch with its
pinned `startPoint`, journal `phase`, and `recoveredFrom` on resume), `registration` and `resumed`.
See `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/create-feature.test.ts packages/cli/src/__tests__/create.test.ts scripts/__tests__/cli-docs.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint and commit**

Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add packages/cli/src/commands/create.ts packages/cli/src/commands/create-feature.ts packages/cli/src/main.ts docs/04-cli-reference.md packages/cli/src/__tests__/create-feature.scenario.ts packages/cli/src/__tests__/create-feature.test.ts
git commit -m "feat: add wtm create --repos and --resume (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Recovery scenarios

**Files:**
- Create: `packages/cli/src/__tests__/create-feature-recovery.scenario.ts`
- Create: `packages/cli/src/__tests__/create-feature-recovery.test.ts`

**Interfaces:**
- Consumes: `runCli` with `featureCreateApply` (Task 6); `createWorktree` from `@wtm/core`; the SQLite schema from Task 1.
- Produces: nothing new. If a case here fails, fix `create-feature.ts` or `create-feature-recovery.ts` in this task, with the fix in the same commit.

- [ ] **Step 1: Write the scenario and test**

`packages/cli/src/__tests__/create-feature-recovery.scenario.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createWorktree } from '@wtm/core';
import type { CliDependencies } from '../main';

/** Partial multi-repository creations and `--resume`, against real Git and a real state store. */
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-create-recovery-')));
const home = join(root, 'home');
const dataRoot = join(home, 'wtm');
const databasePath = join(dataRoot, 'state.db');
const workspaceRoot = join(root, 'ws');
const gitConfig = join(root, 'gitconfig');
const repos = ['web', 'api', 'worker'] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function invoke(argv: readonly string[], dependencies: CliDependencies = {}) {
  const { runCli } = await import('../main');
  let out = '';
  const code = await runCli(argv, {
    cwd: workspaceRoot,
    analysisDatabasePath: databasePath,
    diagnosticsDatabasePath: databasePath,
    removalGlobalConfigPath: join(dataRoot, 'config.toml'),
    daemonSocketPath: join(root, 'd.sock'),
    ...dependencies,
    stdout: (value) => { out += value; },
    stderr: () => {},
  });
  return { code, envelope: JSON.parse(out) as { ok: boolean; data: any; errors: Array<{ code: string; remediation?: any }> } };
}

const create = (argv: string[], dependencies: CliDependencies = {}) => invoke(['create', ...argv, '--json'], dependencies);
const failFor = (name: string): CliDependencies['featureCreateApply'] => async (repoPath, plan) => {
  if (repoPath.endsWith(`${'/'}${name}`) || repoPath.endsWith(`\\${name}`)) throw new Error(`injected failure in ${name}`);
  return await createWorktree(repoPath, plan);
};
/** Git succeeds for `name`, then the process "crashes" before the journal records it. */
const crashAfterGitFor = (name: string): CliDependencies['featureCreateApply'] => async (repoPath, plan) => {
  const record = await createWorktree(repoPath, plan);
  if (repoPath.endsWith(`/${name}`) || repoPath.endsWith(`\\${name}`)) throw new Error(`injected crash in ${name}`);
  return record;
};
const alwaysFail: CliDependencies['featureCreateApply'] = async () => { throw new Error('injected failure'); };
const onDisk = (branch: string) => repos.map((repo) => existsSync(join(workspaceRoot, `${repo}-${branch.replace('/', '-')}`)));
const phases = (envelope: { data: any }) => Object.fromEntries((envelope.data?.members ?? [])
  .map((member: any) => [member.repository.mainRoot.split(/[\\/]/).pop(), member.phase]));
const recoveredFrom = (envelope: { data: any }) => Object.fromEntries((envelope.data?.members ?? [])
  .map((member: any) => [member.repository.mainRoot.split(/[\\/]/).pop(), member.recoveredFrom ?? null]));
const sql = (statement: string, ...parameters: unknown[]) => {
  const database = new Database(databasePath);
  try { return database.prepare(statement).run(...parameters); } finally { database.close(); }
};
const query = (statement: string, ...parameters: unknown[]) => {
  const database = new Database(databasePath);
  try { return database.prepare(statement).all(...parameters); } finally { database.close(); }
};

await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await writeFile(gitConfig, '[safe]\n\tdirectory = *\n');
process.env['HOME'] = home;
process.env['GIT_CONFIG_GLOBAL'] = gitConfig;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
for (const repo of repos) {
  const path = join(workspaceRoot, repo);
  await mkdir(path, { recursive: true });
  git(path, 'init', '--initial-branch=main');
  git(path, 'config', 'user.name', 'WTM Recovery');
  git(path, 'config', 'user.email', 'wtm-recovery@example.invalid');
  await writeFile(join(path, 'README.md'), `${repo}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', repo);
}
const reconcileOk = { request: async () => ({ schemaVersion: 1, ok: true, command: 'reconcile', data: null, warnings: [], errors: [] }) } as never;
const initialized = await invoke(['init', '--yes', '--json'], { initDatabasePath: databasePath, initUserDataDir: dataRoot, runtimeClient: reconcileOk });
if (initialized.code !== 0) throw new Error('wtm init failed');

// Members are applied in repository id order, and ids are random. Failing the member with the
// highest id makes "every member before it was created" deterministic.
const last = (query('SELECT main_root FROM repositories ORDER BY id DESC LIMIT 1') as Array<{ main_root: string }>)[0]!
  .main_root.split(/[\\/]/).pop()!;
const others = repos.filter((repo) => repo !== last);
const exists = (repo: string, branch: string) => existsSync(join(workspaceRoot, `${repo}-${branch.replace('/', '-')}`));

// 1. A Git failure in one member: the others stay, a plain create is refused, resume finishes.
const partial = await create(['feat/partial', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
const partialFailedOnDisk = exists(last, 'feat/partial');
const partialOthersOnDisk = others.map((repo) => exists(repo, 'feat/partial'));
const plainWhileOpen = await create(['feat/partial', '--repos', 'web,api,worker']);
const resumedPartial = await create(['feat/partial', '--resume']);

// 2. Git finished for a member, but the process died before the journal said so.
const crashed = await create(['feat/crashed', '--repos', 'web,api,worker'], { featureCreateApply: crashAfterGitFor('api') });
const crashedPhaseApi = phases(crashed.envelope)['api'];
const resumedCrashed = await create(['feat/crashed', '--resume']);

// 3. The journal says APPLYING, and Git never started.
const halted = await create(['feat/halted', '--repos', 'web,api,worker'], { featureCreateApply: failFor('api') });
sql(`UPDATE feature_creation_members SET phase = 'APPLYING' WHERE worktree_path = ?`, join(workspaceRoot, 'api-feat-halted'));
const resumedHalted = await create(['feat/halted', '--resume']);

// 4. APPLYING, and something that is not a worktree sits at the path: refused, nothing deleted.
const leftover = await create(['feat/leftover', '--repos', 'web,api,worker'], { featureCreateApply: failFor(last) });
const leftoverPath = join(workspaceRoot, `${last}-feat-leftover`);
sql(`UPDATE feature_creation_members SET phase = 'APPLYING' WHERE worktree_path = ?`, leftoverPath);
await mkdir(leftoverPath, { recursive: true });
await writeFile(join(leftoverPath, 'keep.txt'), 'mine\n');
const resumedLeftover = await create(['feat/leftover', '--resume']);

// 5. Nothing written anywhere: a new create with a different member set replaces it.
const nothing = await create(['feat/super', '--repos', 'web,api,worker'], { featureCreateApply: alwaysFail });
const superseding = await create(['feat/super', '--repos', 'web,api']);
const superStates = (query(`SELECT c.state FROM feature_creations c JOIN features f ON f.id = c.feature_id
  WHERE f.branch = 'refs/heads/feat/super' ORDER BY c.created_at`) as Array<{ state: string }>).map(({ state }) => state);

// 6. --resume guards.
const mismatchSetup = await create(['feat/mismatch', '--repos', 'web,api'], { featureCreateApply: failFor('api') });
const mismatch = await create(['feat/mismatch', '--resume', '--repos', 'web']);
const fromWithResume = await create(['feat/mismatch', '--resume', '--from', 'main']);

// 7. A live lease on one member refuses the creation before anything is written.
const web = (query('SELECT id FROM repositories WHERE main_root = ?', join(workspaceRoot, 'web')) as Array<{ id: string }>)[0]!.id;
sql(`INSERT INTO repository_operation_leases (repository_id, operation, token, pid, process_start_time, subject_worktree_id,
  stage, acquired_at, renewed_at, expires_at, host_id) VALUES (?, 'gc', 'held', 999999, 'x', NULL, NULL,
  '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 'elsewhere')`, web);
const busy = await create(['feat/busy', '--repos', 'web,api']);
const busyOnDisk = onDisk('feat/busy');
sql(`DELETE FROM repository_operation_leases WHERE token = 'held'`);

process.stdout.write(JSON.stringify({
  partial: {
    ok: partial.envelope.ok,
    code: partial.envelope.errors[0]?.code ?? null,
    remediation: partial.envelope.errors[0]?.remediation ?? null,
    failedOnDisk: partialFailedOnDisk,
    othersOnDisk: partialOthersOnDisk,
    failedPhase: phases(partial.envelope)[last],
    otherPhases: others.map((repo) => phases(partial.envelope)[repo]),
  },
  plainWhileOpen: { code: plainWhileOpen.envelope.errors[0]?.code ?? null },
  resumedPartial: {
    ok: resumedPartial.envelope.ok,
    resumed: resumedPartial.envelope.data?.resumed ?? null,
    failedRecoveredFrom: recoveredFrom(resumedPartial.envelope)[last],
    otherRecoveredFrom: others.map((repo) => recoveredFrom(resumedPartial.envelope)[repo]),
    phases: Object.values(phases(resumedPartial.envelope)),
    onDisk: onDisk('feat/partial'),
  },
  crashed: { ok: crashed.envelope.ok, apiPhase: crashedPhaseApi },
  resumedCrashed: { ok: resumedCrashed.envelope.ok, recoveredFrom: recoveredFrom(resumedCrashed.envelope), onDisk: onDisk('feat/crashed') },
  resumedHalted: { ok: halted.envelope.ok === false && resumedHalted.envelope.ok, apiRecoveredFrom: recoveredFrom(resumedHalted.envelope)['api'], onDisk: onDisk('feat/halted') },
  resumedLeftover: {
    ok: leftover.envelope.ok === false && resumedLeftover.envelope.ok,
    code: resumedLeftover.envelope.errors[0]?.code ?? null,
    keptFile: existsSync(join(leftoverPath, 'keep.txt')),
    othersStillThere: others.map((repo) => exists(repo, 'feat/leftover')),
  },
  superseded: { firstOk: nothing.envelope.ok, secondOk: superseding.envelope.ok, states: superStates, members: (superseding.envelope.data?.members ?? []).length },
  guards: { setupOk: mismatchSetup.envelope.ok, mismatch: mismatch.envelope.errors[0]?.code ?? null, fromWithResume: fromWithResume.envelope.errors[0]?.code ?? null },
  busy: { code: busy.envelope.errors[0]?.code ?? null, onDisk: busyOnDisk },
}));
```

`packages/cli/src/__tests__/create-feature-recovery.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./create-feature-recovery.scenario.ts', import.meta.url));
let scenario: Record<string, any>;

beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as Record<string, any>;
});

describe('wtm create --resume', () => {
  test('a failed member leaves the others in place and points at --resume', () => {
    // The injected failure is not a GitCommandError, so it maps to GIT_REPOSITORY_DEGRADED; a real
    // Git failure would be GIT_COMMAND_FAILED.
    expect(scenario['partial']).toEqual({
      ok: false,
      code: 'GIT_REPOSITORY_DEGRADED',
      remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'create', 'feat/partial', '--resume'] }],
      failedOnDisk: false,
      othersOnDisk: [true, true],
      failedPhase: 'PLANNED',
      otherPhases: ['APPLIED', 'APPLIED'],
    });
  });

  test('a new create of an unfinished feature is refused', () => {
    expect(scenario['plainWhileOpen']).toEqual({ code: 'WTM_OPERATION_CONFLICT' });
  });

  test('resume finishes the feature, recording where each member was', () => {
    expect(scenario['resumedPartial']).toEqual({
      ok: true, resumed: true,
      failedRecoveredFrom: 'PLANNED',
      otherRecoveredFrom: ['APPLIED', 'APPLIED'],
      phases: ['REGISTERED', 'REGISTERED', 'REGISTERED'],
      onDisk: [true, true, true],
    });
  });

  test('a member Git finished but the journal did not record is recognised, not re-added', () => {
    expect(scenario['crashed']).toEqual({ ok: false, apiPhase: 'APPLYING' });
    expect(scenario['resumedCrashed']).toMatchObject({ ok: true, onDisk: [true, true, true] });
    expect(scenario['resumedCrashed'].recoveredFrom['api']).toBe('APPLYING');
  });

  test('an APPLYING member Git never started is created at its pinned commit', () => {
    expect(scenario['resumedHalted']).toEqual({ ok: true, apiRecoveredFrom: 'APPLYING', onDisk: [true, true, true] });
  });

  test('something unexpected at the path is refused, and nothing is deleted', () => {
    expect(scenario['resumedLeftover']).toEqual({ ok: false, code: 'WTM_WORKTREE_PATH_OCCUPIED', keptFile: true, othersStillThere: [true, true] });
  });

  test('a creation that wrote nothing is superseded by a new create', () => {
    expect(scenario['superseded']).toEqual({ firstOk: false, secondOk: true, states: ['SUPERSEDED', 'COMPLETED'], members: 2 });
  });

  test('--resume refuses a different --repos set and any --from', () => {
    expect(scenario['guards']).toEqual({ setupOk: false, mismatch: 'WTM_CONFIG_INVALID', fromWithResume: 'WTM_CONFIG_INVALID' });
  });

  test('a held lease on one member refuses the creation before anything is written', () => {
    expect(scenario['busy']).toEqual({ code: 'WTM_OPERATION_CONFLICT', onDisk: [false, false, false] });
  });
});
```

The cases that fail a named member (`crashAfterGitFor('api')`, `failFor('api')` in case 3 and in the `--resume` guards) do not depend on the id order: members before `api` end APPLIED, members after it stay PLANNED, and `--resume` completes both kinds, which is what those cases assert.

- [ ] **Step 2: Run the test**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/create-feature-recovery.test.ts`
Expected: PASS. A failure here is a defect in the Task 5 or Task 6 code; fix it there and commit the fix with this task.

- [ ] **Step 3: Typecheck, lint and commit**

Run: `bun run typecheck && bun run lint`
Expected: clean.

```bash
git add packages/cli/src/__tests__/create-feature-recovery.scenario.ts packages/cli/src/__tests__/create-feature-recovery.test.ts
git commit -m "test: prove wtm create --resume against partial and crashed creations (item 6)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Remaining documentation

**Files:**
- Modify: `docs/18-errors-json-contract.md`
- Modify: `docs/03-configuration-spec.md` (endpoint sharing per feature, around lines 177–180)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `todo.md` (item 6)
- Modify: `docs/superpowers/specs/2026-09-07-create-worktree.md` (Status)

**Interfaces:** none.

- [ ] **Step 1: `docs/18-errors-json-contract.md`**

Find the paragraph that lists the `create` refusal codes (search for `WTM_WORKTREE_PATH_OCCUPIED`). After it, add:

```markdown
A multi-repository `wtm create --repos` (and `--resume`) reports every pre-flight refusal in
`errors`, one item per member, each with `context.repository`. Its `data` is present on failure as
well as success once the creation is journalled: `feature` (`id`, `branch`), `members[]`
(`repository`, `worktree` or null, `branch` with the pinned `startPoint`, `phase`, and on resume
`recoveredFrom`), `registration` (`daemon`, `local`, or null when registration was not reached)
and `resumed`. A member's Git failure carries a `wtm create <branch> --resume` remediation.
`WTM_OPERATION_CONFLICT` means a `create` lease on a member is held, or the feature has an
unfinished creation; `WTM_CONFIG_INVALID` covers an unknown or ambiguous `--repos` name, a
`--repos` set that does not match the creation being resumed, `--from` with `--resume`, `--resume`
with nothing to resume, and a member repository that is no longer registered.
```

- [ ] **Step 2: `docs/03-configuration-spec.md`**

After the paragraph that says endpoints are allocated per feature, add:

```markdown
A feature is still "one workspace, one branch". `wtm create --repos` records that group with a
persistent id when it creates it, but the grouping rule itself does not change: a worktree on the
same branch that WTM did not create joins the feature exactly as before.
```

- [ ] **Step 3: `CHANGELOG.md`**

Add at the top of `### Added` under `## [Unreleased]`:

```markdown
- `wtm create <branch> --repos web,api,worker` creates the branch in several repositories of a
  workspace as one feature, with a start commit pinned per repository, every refusal decided
  before Git writes, and a `create` lease on each member. A partial creation is journalled, and
  `wtm create <branch> --resume` finishes it by inspecting each member's real Git state; it never
  re-runs an uncertain step blindly and never deletes anything. Migration 014 adds the feature
  and creation journal tables.
```

- [ ] **Step 4: `todo.md` item 6**

- Change the heading `### [ ] 6. \`wtm create\` ekle` to `### [x] 6. \`wtm create\` ekle`.
- Tick `- [ ] Multi-repo branch alignment.` and `- [ ] Partial multi-repo creation rollback/recovery.`, replacing each "— **açık.** …" explanation with a one-line pointer: `— \`--repos\`; spec \`docs/superpowers/specs/2026-09-13-multi-repo-create-design.md\`.` and `— journal + \`--resume\`; aynı spec, §4.`
- Tick both open acceptance criteria, replacing "— **bu dalganın kapsamı dışında.** …" with `— \`packages/cli/src/__tests__/create-feature.test.ts\`.` and `— \`packages/cli/src/__tests__/create-feature-recovery.test.ts\` ve \`packages/core/src/analysis/__tests__/create-feature-recovery.test.ts\`.`
- Replace the paragraph starting `**Kısmen kapandı.**` with:

```markdown
**Kapandı (2026-09-13).** Tek repo create 2026-09-07'de, çok repolu create ve kurtarma
2026-09-13'te: spec `docs/superpowers/specs/2026-09-13-multi-repo-create-design.md`, plan
`docs/superpowers/plans/2026-09-13-multi-repo-create.md`. Feature kimliği mevcut "aynı workspace,
aynı branch" gruplamasının kalıcı kaydı; yarım kalan oluşturma silinmez, `--resume` ile tamamlanır.
Kapsam dışı bırakılanlar: `--abandon`, daemon açılışında otomatik tamamlama, `wtm doctor` bulgusu,
feature düzeyinde olay, repolar arasında farklı branch adları.
```

- [ ] **Step 5: `docs/superpowers/specs/2026-09-07-create-worktree.md`**

Replace the `## Status` paragraph with:

```markdown
Shipped for a single repository. The multi-repository half deferred below is specified in
[`2026-09-13-multi-repo-create-design.md`](2026-09-13-multi-repo-create-design.md). "`create` takes
no repository operation lease" still holds for single-repository create; a multi-repository create
takes a `create` lease on each member.
```

- [ ] **Step 6: Run the documentation checks and commit**

Run: `bun test --timeout 60000 scripts/__tests__`
Expected: PASS.

```bash
git add docs/18-errors-json-contract.md docs/03-configuration-spec.md CHANGELOG.md todo.md docs/superpowers/specs/2026-09-07-create-worktree.md
git commit -m "docs: document multi-repository create and close todo item 6

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Full gate

- [ ] **Step 1: Run the full suite once**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: 0 failures. Record the pass/skip/fail counts for the PR description.

- [ ] **Step 2: Fix anything red in the task that owns it, re-run only the affected files, then the full suite once more.**
