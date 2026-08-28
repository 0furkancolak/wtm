import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceGcJournalInput } from '../store';
import { SQLiteStateStore } from '../sqlite-store';

const root = mkdtempSync(join(tmpdir(), 'wtm-resource-finalization-'));

function setupObject(store: SQLiteStateStore, id: string, ino: number): ResourceGcJournalInput {
  store.upsertResourceSandbox({
    id: 'sandbox', root: '/private/resources', generation: 'generation', dev: 1, ino: 2, uid: 501,
  });
  store.registerResourceStorageObject({
    id, sandboxId: 'sandbox', path: `/private/resources/${id}`, dev: 1, ino, uid: 501,
    kind: 'file', state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 1, allocatedBytes: 4096,
  });
  const evidence = {
    storageObjectId: id, sandboxId: 'sandbox', sandboxGeneration: 'generation',
    path: `/private/resources/${id}`, dev: 1, ino, uid: 501, kind: 'file' as const,
    state: 'STALE' as const, retention: 'ephemeral' as const,
  };
  if (!store.acquireResourceCleanupLease(evidence, `${id}-token`, 60_000)) throw new Error('fixture lease failed');
  const entry: ResourceGcJournalInput = {
    operationId: `${id}-operation`, storageObjectId: id, phase: 'deleted',
    originalPath: evidence.path, quarantinePath: `/private/resources/.wtm-gc-${id}/object`,
    dev: 1, ino, uid: 501, sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file',
    quarantineContainer: null,
  };
  store.recordResourceGcJournal(entry);
  return entry;
}

function createV7Fixture(path: string): ResourceGcJournalInput {
  const database = new Database(path);
  database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (let version = 1; version <= 7; version += 1) {
    const migration = readFileSync(new URL(`../migrations/${String(version).padStart(3, '0')}-${[
      'initial', 'managed-process-indexes', 'managed-process-reservations', 'managed-process-reservation-leases',
      'managed-process-cleanup-ownership', 'resource-lifecycle', 'resource-gc-deleting-phase',
    ][version - 1]}.sql`, import.meta.url), 'utf8');
    database.exec(migration);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, '2020-01-01T00:00:00.000Z');
  }
  database.prepare(`INSERT INTO resource_sandboxes VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('sandbox', '/private/resources', 'generation', 1, 2, 501, '2020-01-01T00:00:00.000Z');
  database.prepare(`INSERT INTO resource_storage_objects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'upgraded', 'sandbox', '/private/resources/upgraded', 1, 42, 501, 'file', 'REMOVED', 'ephemeral', 1,
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 1, 4096,
    );
  database.prepare(`INSERT INTO resource_gc_journal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'upgraded-operation', 'upgraded', 'deleted', '/private/resources/upgraded',
      '/private/resources/.wtm-gc-upgraded/object', 1, 42, 501, 'sandbox', 'generation', 'file',
      '2020-01-01T00:00:00.000Z',
    );
  database.close();
  return {
    operationId: 'upgraded-operation', storageObjectId: 'upgraded', phase: 'finalized',
    originalPath: '/private/resources/upgraded', quarantinePath: '/private/resources/.wtm-gc-upgraded/object',
    dev: 1, ino: 42, uid: 501, sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file',
    quarantineContainer: null,
  };
}

try {
  const databasePath = join(root, 'atomic.db');
  const store = new SQLiteStateStore(databasePath);
  const atomicEntry = setupObject(store, 'atomic', 3);
  const triggerDatabase = new Database(databasePath);
  triggerDatabase.exec(`
    CREATE TRIGGER fail_gc_journal_finalize
    BEFORE UPDATE OF phase ON resource_gc_journal
    WHEN NEW.operation_id = 'atomic-operation' AND NEW.phase = 'finalized'
    BEGIN SELECT RAISE(ABORT, 'injected finalize crash'); END
  `);
  triggerDatabase.close();
  let transactionBoundaryFailed = false;
  try {
    store.finalizeResourceCleanupJournal({ ...atomicEntry, phase: 'finalized' }, 'atomic-token');
  } catch {
    transactionBoundaryFailed = true;
  }
  const afterBoundary = store.listResourceGcEvidence().find((item) => item.storageObjectId === 'atomic');
  const journalAfterBoundary = store.listResourceGcJournal().find((item) => item.storageObjectId === 'atomic');
  const removeTrigger = new Database(databasePath);
  removeTrigger.exec('DROP TRIGGER fail_gc_journal_finalize');
  removeTrigger.close();
  const atomicReplayFinalized = store.finalizeResourceCleanupJournal(
    { ...atomicEntry, phase: 'finalized' }, 'atomic-token',
  );
  const atomicAfterReplay = store.listResourceGcEvidence().find((item) => item.storageObjectId === 'atomic');
  const atomicJournalAfterReplay = store.listResourceGcJournal().find((item) => item.storageObjectId === 'atomic');

  const splitEntry = setupObject(store, 'split', 4);
  const oldSplitObjectFinalized = store.finalizeResourceCleanup('split', 'split-token');
  const splitReplayFinalized = store.finalizeResourceCleanupJournal(
    { ...splitEntry, phase: 'finalized' }, 'expired-old-token',
  );
  const splitJournal = store.listResourceGcJournal().find((item) => item.storageObjectId === 'split');
  store.close();

  const upgradedPath = join(root, 'upgraded-v7.db');
  const upgradedEntry = createV7Fixture(upgradedPath);
  const upgradedStore = new SQLiteStateStore(upgradedPath);
  const upgradedContainerIdentityIsNull = upgradedStore.listResourceGcJournal()[0]?.quarantineContainer === null;
  const upgradedReplayFinalized = upgradedStore.finalizeResourceCleanupJournal(upgradedEntry, 'missing-legacy-token');
  const upgradedJournal = upgradedStore.listResourceGcJournal()[0];
  upgradedStore.close();

  process.stdout.write(JSON.stringify({
    transactionBoundaryFailed,
    boundaryObjectState: afterBoundary?.state,
    boundaryJournalPhase: journalAfterBoundary?.phase,
    atomicReplayFinalized,
    atomicObjectState: atomicAfterReplay?.state,
    atomicJournalPhase: atomicJournalAfterReplay?.phase,
    oldSplitObjectFinalized,
    splitReplayFinalized,
    splitJournalPhase: splitJournal?.phase,
    upgradedContainerIdentityIsNull,
    upgradedReplayFinalized,
    upgradedJournalPhase: upgradedJournal?.phase,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
