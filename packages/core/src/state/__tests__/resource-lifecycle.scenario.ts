import { SQLiteStateStore } from '../sqlite-store';

const store = new SQLiteStateStore(':memory:');
try {
  store.upsertResourceSandbox({
    id: 'sandbox', root: '/private/resources', generation: 'generation-1', dev: 1, ino: 2, uid: 501,
  });
  let sandboxCasRejected = false;
  try {
    store.upsertResourceSandbox({
      id: 'sandbox', root: '/private/resources', generation: 'generation-2', dev: 1, ino: 99, uid: 501,
    });
  } catch {
    sandboxCasRejected = true;
  }
  store.registerResourceStorageObject({
    id: 'object', sandboxId: 'sandbox', path: '/private/resources/stale', dev: 1, ino: 3, uid: 501,
    kind: 'directory', state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 100, allocatedBytes: 4096,
  });
  store.addResourceReference({
    id: 'reference', storageObjectId: 'object', ownerType: 'worktree', ownerId: 'worktree-1',
    resourceName: 'build', createdAt: '2020-01-01T00:00:00.000Z',
  });
  const cleanupEvidence = {
    storageObjectId: 'object', sandboxId: 'sandbox', sandboxGeneration: 'generation-1',
    path: '/private/resources/stale', dev: 1, ino: 3, uid: 501, kind: 'directory' as const,
    state: 'STALE' as const, retention: 'ephemeral' as const,
  };
  const leaseWhileReferenced = store.acquireResourceCleanupLease(
    cleanupEvidence, 'lease-1', 60_000,
  );
  const referenceReleased = store.releaseResourceReference('reference', '2026-08-28T00:00:00.000Z');
  const firstLease = store.acquireResourceCleanupLease(
    cleanupEvidence, 'lease-1', 60_000,
  );
  const contendedLease = store.acquireResourceCleanupLease(
    cleanupEvidence, 'lease-2', 60_000,
  );
  const mismatchedLease = store.acquireResourceCleanupLease(
    { ...cleanupEvidence, path: '/private/resources/other', ino: 99 },
    'lease-3', 60_000,
  );
  let referenceWhileLeasedRejected = false;
  try {
    store.addResourceReference({
      id: 'late-reference', storageObjectId: 'object', ownerType: 'worktree', ownerId: 'worktree-2',
      resourceName: 'build', createdAt: '2026-08-28T00:00:00.000Z',
    });
  } catch {
    referenceWhileLeasedRejected = true;
  }
  const evidence = store.listResourceGcEvidence()[0];
  store.registerResourceStorageObject({
    id: 'expired-object', sandboxId: 'sandbox', path: '/private/resources/expired', dev: 1, ino: 4, uid: 501,
    kind: 'file', state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 1, allocatedBytes: 4096,
  });
  const expiredEvidence = {
    storageObjectId: 'expired-object', sandboxId: 'sandbox', sandboxGeneration: 'generation-1',
    path: '/private/resources/expired', dev: 1, ino: 4, uid: 501, kind: 'file' as const,
    state: 'STALE' as const, retention: 'ephemeral' as const,
  };
  const nonPositiveLeaseRejected = !store.acquireResourceCleanupLease(expiredEvidence, 'invalid-lease', 0);
  const expiredLeaseAcquired = store.acquireResourceCleanupLease(expiredEvidence, 'expired-lease', 1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const expiredLeaseVisible = store.listResourceGcEvidence('1900-01-01T00:00:00.000Z')
    .find((record) => record.storageObjectId === 'expired-object')?.cleanupLeaseToken !== null;
  const expiredLeaseReacquired = store.acquireResourceCleanupLease(
    { ...expiredEvidence, state: 'QUARANTINED' }, 'replacement-lease', 60_000,
  );
  const expiredOldOwnerRenewRejected = !store.renewResourceCleanupLease(
    { ...expiredEvidence, state: 'QUARANTINED' }, 'expired-lease', 60_000,
  );
  let futureDatedReferenceRejected = false;
  try {
    store.addResourceReference({
      id: 'expired-reference', storageObjectId: 'expired-object', ownerType: 'worktree', ownerId: 'worktree-3',
      resourceName: 'build', createdAt: '2099-01-01T00:00:00.000Z',
    });
  } catch {
    futureDatedReferenceRejected = true;
  }
  for (const phase of ['prepared', 'linked', 'unlinking', 'quarantined', 'deleting', 'deleted', 'finalized'] as const) {
    store.recordResourceGcJournal({
      operationId: 'operation', storageObjectId: 'object', phase,
      originalPath: '/private/resources/stale', quarantinePath: phase === 'prepared' ? null : '/private/resources/.q',
      dev: 1, ino: 3, uid: 501, sandboxId: 'sandbox', sandboxGeneration: 'generation-1', kind: 'directory',
      quarantineContainer: null,
    });
  }
  const wrongOwnerFinalized = store.finalizeResourceCleanup('object', 'other');
  const ownerFinalized = store.finalizeResourceCleanup('object', 'lease-1');
  const finalized = store.listResourceGcEvidence().find((record) => record.storageObjectId === 'object');
  const journal = store.listResourceGcJournal()[0];
  process.stdout.write(JSON.stringify({
    leaseWhileReferenced,
    referenceReleased,
    firstLease,
    contendedLease,
    mismatchedLease,
    referenceWhileLeasedRejected,
    nonPositiveLeaseRejected,
    expiredLeaseAcquired,
    expiredLeaseVisible,
    expiredLeaseReacquired,
    expiredOldOwnerRenewRejected,
    futureDatedReferenceRejected,
    evidence: {
      referenceCount: evidence?.referenceCount,
      cleanupLeaseToken: evidence?.cleanupLeaseToken,
      sandboxGeneration: evidence?.sandboxGeneration,
    },
    wrongOwnerFinalized,
    ownerFinalized,
    state: finalized?.state,
    phase: journal?.phase,
    sandboxCasRejected,
  }));
} finally {
  store.close();
}
