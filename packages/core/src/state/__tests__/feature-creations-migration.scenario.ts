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
