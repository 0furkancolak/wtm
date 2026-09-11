import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemMigrationAssets } from '../assets';
import { betterSqliteDatabaseFactory } from '../better-sqlite-driver';
import { SQLiteStateStore } from '../sqlite-store';

const root = await mkdtemp(join(tmpdir(), 'wtm-memory-upgrade-'));
const path = join(root, 'state.db');
try {
  const old = new SQLiteStateStore(path, { migrationAssets: { readMigrations: () => filesystemMigrationAssets.readMigrations().slice(0, 12) } });
  old.close();
  const raw = betterSqliteDatabaseFactory(path, { readonly: false });
  raw.prepare(`INSERT INTO heavy_jobs (job_id, scope, workspace_id, repository_id, worktree_id, worktree_path,
    task_name, idempotency_key, command_fingerprint, source_fingerprint, timeout_ms, state,
    slot_held, anchor_pid, stop_reason, created_at, started_at) VALUES
    ('legacy', 'host:user', 'workspace', 'repo', 'tree', '/repo', 'build', 'retry', 'command',
    'source', 60000, 'RUNNING', 1, 123, 'CANCELLED', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:01.000Z')`).run();
  const before = raw.prepare('SELECT * FROM heavy_jobs').get() as Record<string, unknown>;
  raw.close();
  const upgraded = new SQLiteStateStore(path);
  try {
    const after = betterSqliteDatabaseFactory(path, { readonly: true });
    try { assert.deepEqual(after.prepare('SELECT * FROM heavy_jobs').get(), { ...before, memory_estimate_bytes: null }); }
    finally { after.close(); }
    const job = upgraded.jobs.get('legacy', 'host:user');
    assert.equal(job?.memoryEstimateBytes, null);
    assert.equal(job?.slotHeld, true);
    assert.equal(job?.stopReason, 'CANCELLED');
  } finally { upgraded.close(); }
  console.log(JSON.stringify({ ok: true }));
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
