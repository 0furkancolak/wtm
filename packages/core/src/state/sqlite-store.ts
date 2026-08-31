import { randomUUID } from 'node:crypto';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type { MigrationAssetProvider } from './assets';
import type { SqliteDatabase, SqliteDatabaseFactory } from './database';
import { stateStoreRuntime } from './runtime';
import type {
  LifecycleEventSubject,
  AdapterTrustInput,
  AdapterTrustRecord,
  EndpointLease,
  EndpointLeaseQuery,
  EndpointAvailabilityProbe,
  EndpointRequest,
  ManagedProcessInput,
  ManagedProcessCreateOptions,
  ManagedProcessQuery,
  ManagedProcessRecord,
  ManagedProcessReservationOptions,
  ManagedProcessState,
  ManagedProcessUpdate,
  ReconcileResult,
  RepositoryInput,
  RepositoryOperation,
  RepositoryOperationLeaseHolder,
  RepositoryOperationLeaseKey,
  RepositoryOperationLeaseRequest,
  RepositoryOperationLeaseResult,
  RepositoryRecord,
  ResourceGcEvidenceRecord,
  ResourceGcJournalInput,
  ResourceCleanupLeaseRequest,
  ResourceReferenceInput,
  ResourceSandboxInput,
  ResourceStorageObjectInput,
  StateStore,
  WorkspaceInput,
  WorkspaceRecord,
  WorktreeRecord,
  WorktreeState,
} from './store';

/**
 * How many ports one allocation may ask the operating system about. Each question is a
 * process, so the answer to "is this whole range busy?" must cost a bounded amount rather
 * than one spawn per port in a range that is thirty thousand wide by default.
 */
const maxProbedEndpointCandidates = 256;

interface WorkspaceRow {
  id: string;
  name: string;
  root: string;
  scope: WorkspaceRecord['scope'];
  config_path: string | null;
  created_at: string;
  last_seen_at: string;
}

interface RepositoryRow {
  id: string;
  workspace_id: string;
  common_git_dir: string;
  main_root: string;
  remote_identity: string | null;
  created_at: string;
  last_reconciled_at: string | null;
}

interface WorktreeRow {
  id: string;
  repository_id: string;
  numeric_id: number;
  path: string;
  branch: string | null;
  head_oid: string | null;
  is_main: 0 | 1;
  is_locked: 0 | 1;
  state: WorktreeState;
  created_at: string;
  last_seen_at: string;
  last_runtime_at: string | null;
}

interface EndpointRow {
  id: string;
  worktree_id: string;
  name: string;
  protocol: EndpointLease['protocol'];
  host: string;
  port: number;
  state: EndpointLease['state'];
  allocated_at: string;
  last_verified_at: string;
}

interface AdapterTrustRow {
  adapter_id: string;
  canonical_path: string;
  sha256: string;
  trusted_at: string;
}

interface ManagedProcessRow {
  id: string;
  worktree_id: string;
  task_name: string;
  pid: number;
  pgid: number;
  process_start_time: string;
  command_fingerprint: string;
  state: ManagedProcessState;
  started_at: string;
  stopped_at: string | null;
  stdout_path: string;
  stderr_path: string;
  cleanup_required: 0 | 1;
  cleanup_owner_token: string | null;
}

interface RepositoryOperationLeaseRow {
  repository_id: string;
  operation: RepositoryOperation;
  token: string;
  pid: number;
  process_start_time: string;
  subject_worktree_id: string | null;
  stage: string | null;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
}

function repositoryOperationLeaseHolderFromRow(row: RepositoryOperationLeaseRow): RepositoryOperationLeaseHolder {
  return {
    repositoryId: row.repository_id,
    operation: row.operation,
    pid: row.pid,
    processStartTime: row.process_start_time,
    subjectWorktreeId: row.subject_worktree_id,
    stage: row.stage,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
  };
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    scope: row.scope,
    configPath: row.config_path,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function repositoryFromRow(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    commonGitDir: row.common_git_dir,
    mainRoot: row.main_root,
    remoteIdentity: row.remote_identity,
    createdAt: row.created_at,
    lastReconciledAt: row.last_reconciled_at,
  };
}

function worktreeFromRow(row: WorktreeRow): WorktreeRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    numericId: row.numeric_id,
    path: row.path,
    branch: row.branch,
    headOid: row.head_oid,
    isMain: row.is_main === 1,
    isLocked: row.is_locked === 1,
    state: row.state,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastRuntimeAt: row.last_runtime_at,
  };
}

function endpointFromRow(row: EndpointRow): EndpointLease {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    state: row.state,
    allocatedAt: row.allocated_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

function adapterTrustFromRow(row: AdapterTrustRow): AdapterTrustRecord {
  return {
    adapterId: row.adapter_id,
    canonicalPath: row.canonical_path,
    sha256: row.sha256,
    trustedAt: row.trusted_at,
  };
}

function managedProcessFromRow(row: ManagedProcessRow): ManagedProcessRecord {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    taskName: row.task_name,
    pid: row.pid,
    pgid: row.pgid,
    processStartTime: row.process_start_time,
    commandFingerprint: row.command_fingerprint,
    state: row.state,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    cleanupRequired: row.cleanup_required === 1,
    ...(row.cleanup_owner_token === null ? {} : { cleanupOwnerToken: row.cleanup_owner_token }),
  };
}

function compareWorktreePaths(mainRoot: string) {
  return (left: { path: string }, right: { path: string }): number => {
    if (left.path === mainRoot) return right.path === mainRoot ? 0 : -1;
    if (right.path === mainRoot) return 1;
    return left.path.localeCompare(right.path);
  };
}

export interface SQLiteStateStoreOptions {
  readonly?: boolean;
  migrationAssets?: MigrationAssetProvider;
  databaseFactory?: SqliteDatabaseFactory;
}

export class SQLiteStateStore implements StateStore {
  readonly #database: SqliteDatabase;
  #closed = false;

  constructor(path: string, options: SQLiteStateStoreOptions = {}) {
    const runtime = stateStoreRuntime();
    this.#database = (options.databaseFactory ?? runtime.databaseFactory)(path, {
      readonly: options.readonly === true,
    });
    try {
      this.#database.pragma('foreign_keys = ON');
      if (options.readonly !== true && path !== ':memory:' && !path.startsWith('file::memory:')) {
        this.#database.pragma('journal_mode = WAL');
      }
      this.#database.pragma('busy_timeout = 5000');
      if (options.readonly !== true) this.#migrate(options.migrationAssets ?? runtime.migrationAssets);
    } catch (error) {
      try {
        this.#database.close();
      } finally {
        this.#closed = true;
      }
      throw error;
    }
  }

  upsertWorkspace(input: WorkspaceInput): WorkspaceRecord {
    this.#assertOpen();
    const timestamp = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO workspaces (id, name, root, scope, config_path, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (root) DO UPDATE SET
        name = excluded.name,
        scope = excluded.scope,
        config_path = excluded.config_path,
        last_seen_at = excluded.last_seen_at
    `).run(randomUUID(), input.name, input.root, input.scope, input.configPath, timestamp, timestamp);

    const row = this.#database
      .prepare('SELECT * FROM workspaces WHERE root = ?')
      .get(input.root) as WorkspaceRow;
    return workspaceFromRow(row);
  }

  upsertRepository(input: RepositoryInput): RepositoryRecord {
    this.#assertOpen();
    const timestamp = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO repositories (
        id, workspace_id, common_git_dir, main_root, remote_identity, created_at, last_reconciled_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (workspace_id, common_git_dir) DO UPDATE SET
        main_root = excluded.main_root,
        remote_identity = excluded.remote_identity
    `).run(
      randomUUID(),
      input.workspaceId,
      input.commonGitDir,
      input.mainRoot,
      input.remoteIdentity,
      timestamp,
    );

    const row = this.#database
      .prepare('SELECT * FROM repositories WHERE workspace_id = ? AND common_git_dir = ?')
      .get(input.workspaceId, input.commonGitDir) as RepositoryRow;
    return repositoryFromRow(row);
  }

  reconcileWorktrees(repositoryId: string, snapshot: GitWorktreeRecord[]): ReconcileResult {
    this.#assertOpen();
    return this.transaction(() => {
      const repository = this.#database
        .prepare('SELECT * FROM repositories WHERE id = ?')
        .get(repositoryId) as RepositoryRow | undefined;
      if (repository === undefined) throw new Error(`Unknown repository: ${repositoryId}`);

      const uniqueSnapshot = new Map<string, GitWorktreeRecord>();
      for (const worktree of snapshot) uniqueSnapshot.set(worktree.path, worktree);
      const orderedSnapshot = [...uniqueSnapshot.values()].sort(compareWorktreePaths(repository.main_root));
      const existingRows = this.#database
        .prepare('SELECT * FROM worktrees WHERE repository_id = ?')
        .all(repositoryId) as WorktreeRow[];
      const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
      const timestamp = new Date().toISOString();
      const discovered: WorktreeRecord[] = [];
      const updated: WorktreeRecord[] = [];
      const orphaned: WorktreeRecord[] = [];
      let nextNumericId = existingRows.reduce((maximum, row) => Math.max(maximum, row.numeric_id), 0) + 1;

      for (const snapshotRecord of orderedSnapshot) {
        const existing = existingByPath.get(snapshotRecord.path);
        if (existing === undefined) {
          const id = randomUUID();
          this.#database.prepare(`
            INSERT INTO worktrees (
              id, repository_id, numeric_id, path, branch, head_oid, is_main, is_locked,
              state, created_at, last_seen_at, last_runtime_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, ?, NULL)
          `).run(
            id,
            repositoryId,
            nextNumericId,
            snapshotRecord.path,
            snapshotRecord.branch,
            snapshotRecord.head,
            snapshotRecord.path === repository.main_root ? 1 : 0,
            snapshotRecord.lockedReason === null ? 0 : 1,
            timestamp,
            timestamp,
          );
          const row = this.#database.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow;
          discovered.push(worktreeFromRow(row));
          nextNumericId += 1;
          continue;
        }

        const nextState = existing.state === 'ORPHANED' ? 'DISCOVERED' : existing.state;
        this.#database.prepare(`
          UPDATE worktrees SET
            branch = ?, head_oid = ?, is_main = ?, is_locked = ?, state = ?, last_seen_at = ?
          WHERE id = ?
        `).run(
          snapshotRecord.branch,
          snapshotRecord.head,
          snapshotRecord.path === repository.main_root ? 1 : 0,
          snapshotRecord.lockedReason === null ? 0 : 1,
          nextState,
          timestamp,
          existing.id,
        );
        const row = this.#database.prepare('SELECT * FROM worktrees WHERE id = ?').get(existing.id) as WorktreeRow;
        updated.push(worktreeFromRow(row));
      }

      const presentPaths = new Set(uniqueSnapshot.keys());
      const cleanupOwnedStates = new Set<WorktreeState>([
        'ORPHANED',
        'CLEANING',
        'REMOVED',
        'DEGRADED_CLEANUP',
      ]);
      // Absence is settled for these two; the other cleanup-owned states are mid-teardown and
      // their ports belong to whatever is still tearing them down.
      const settledAbsentStates = new Set<WorktreeState>(['ORPHANED', 'REMOVED']);
      for (const existing of existingRows.sort(compareWorktreePaths(repository.main_root))) {
        if (presentPaths.has(existing.path)) continue;
        const cleanupOwned = cleanupOwnedStates.has(existing.state);
        if (!cleanupOwned || settledAbsentStates.has(existing.state)) {
          // A worktree Git no longer reports is not listening on anything, and its ports were
          // being held forever: a workspace that opens and finishes ten branches ended up with
          // ten dead leases inside a fixed band, and `wtm ports` listed addresses for
          // directories that were gone. Releasing is reversible — a worktree that comes back
          // reactivates its own lease, and keeps its port unless something else has taken it.
          //
          // Every pass that finds it absent releases, not only the pass that first noticed.
          // Tying the release to the transition meant a lease leaked before this existed — by
          // an older version, or by an interruption at exactly that moment — held its port for
          // the life of the database, with nothing able to reach it again. The statement costs
          // nothing once there is nothing left to release.
          this.#database.prepare(`
            UPDATE endpoint_leases SET state = 'RELEASED' WHERE worktree_id = ? AND state = 'ACTIVE'
          `).run(existing.id);
        }
        if (cleanupOwned) continue;
        this.#database.prepare("UPDATE worktrees SET state = 'ORPHANED' WHERE id = ?").run(existing.id);
        const row = this.#database.prepare('SELECT * FROM worktrees WHERE id = ?').get(existing.id) as WorktreeRow;
        orphaned.push(worktreeFromRow(row));
      }

      this.#database
        .prepare('UPDATE repositories SET last_reconciled_at = ? WHERE id = ?')
        .run(timestamp, repositoryId);
      return { discovered, updated, orphaned };
    });
  }

  listWorkspaces(): WorkspaceRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare('SELECT * FROM workspaces ORDER BY root, id')
      .all() as WorkspaceRow[];
    return rows.map(workspaceFromRow);
  }

  /**
   * Removes one workspace registration, and everything that only exists because of it.
   *
   * A registration outlives the directory it names — a finished migration deleted, a clone
   * moved, a volume gone for good — and there was no way to say so. The daemon now serves the
   * rest of the machine regardless, but `wtm doctor` still reports the absence on every run,
   * with nothing a person can do about it. Repositories, worktrees, endpoint leases and
   * process records cascade from the workspace row, so one delete retires the whole of it.
   */
  forgetWorkspace(workspaceId: string): boolean {
    this.#assertOpen();
    return this.#database.transaction(() => {
      const worktreeIds = this.#database
        .prepare(`SELECT worktrees.id AS id FROM worktrees
          JOIN repositories ON repositories.id = worktrees.repository_id
          WHERE repositories.workspace_id = ?`)
        .all(workspaceId) as Array<{ id: string }>;
      for (const { id } of worktreeIds) {
        // Reservation rows key on a worktree without declaring a foreign key to it, so the
        // cascade does not reach them and they would outlive everything they refer to.
        this.#database.prepare('DELETE FROM managed_process_start_reservations WHERE worktree_id = ?').run(id);
      }
      const repositoryIds = this.#database
        .prepare('SELECT id FROM repositories WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: string }>;
      // The cascade reaches operation leases, and the explicit delete is what the tests
      // assert: a lease naming a repository that no longer exists would refuse an operation
      // nobody could ever release.
      const forgetOperationLeases = this.#database
        .prepare('DELETE FROM repository_operation_leases WHERE repository_id = ?');
      for (const { id } of repositoryIds) forgetOperationLeases.run(id);
      // Announcement records carry no foreign key, so that forgetting a subject cannot be
      // undone by a cascade resurrecting it. They are cleared here instead.
      const forgetEvents = this.#database
        .prepare('DELETE FROM lifecycle_event_dispatches WHERE subject_type = ? AND subject_id = ?');
      forgetEvents.run('workspace', workspaceId);
      for (const { id } of repositoryIds) forgetEvents.run('repository', id);
      for (const { id } of worktreeIds) forgetEvents.run('worktree', id);
      const result = this.#database.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      return result.changes > 0;
    }).immediate();
  }

  /**
   * Records that a once-only lifecycle event has been announced for this subject, and reports
   * whether this call is the one that announced it.
   *
   * Some events describe something that happens once — a worktree WTM has just learned of, a
   * repository registered for the first time. Deciding that from memory means announcing it
   * again after every daemon restart, which for an event bound to `deps.install` means
   * installing dependencies again on every reboot.
   */
  claimLifecycleEvent(
    subjectType: LifecycleEventSubject,
    subjectId: string,
    event: string,
    now = new Date().toISOString(),
  ): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      INSERT OR IGNORE INTO lifecycle_event_dispatches (subject_type, subject_id, event, dispatched_at)
      VALUES (?, ?, ?, ?)
    `).run(subjectType, subjectId, event, now).changes === 1;
  }

  /**
   * Removes one repository registration, and everything that only exists because of it.
   *
   * Retiring the whole workspace is the wrong instrument when the workspace is alive and only
   * one of its repositories has gone: six finished migrations inside a workspace whose other
   * repositories are in daily use reported themselves as unavailable on every pass, and the
   * only thing that could have silenced them would also have retired the live ones. Worktrees,
   * leases and process records cascade from the repository row.
   */
  forgetRepository(repositoryId: string): boolean {
    this.#assertOpen();
    return this.#database.transaction(() => {
      const worktreeIds = this.#database
        .prepare('SELECT id FROM worktrees WHERE repository_id = ?')
        .all(repositoryId) as Array<{ id: string }>;
      for (const { id } of worktreeIds) {
        this.#database.prepare('DELETE FROM managed_process_start_reservations WHERE worktree_id = ?').run(id);
      }
      this.#database
        .prepare('DELETE FROM repository_operation_leases WHERE repository_id = ?')
        .run(repositoryId);
      const forgetEvents = this.#database
        .prepare('DELETE FROM lifecycle_event_dispatches WHERE subject_type = ? AND subject_id = ?');
      forgetEvents.run('repository', repositoryId);
      for (const { id } of worktreeIds) forgetEvents.run('worktree', id);
      const result = this.#database.prepare('DELETE FROM repositories WHERE id = ?').run(repositoryId);
      return result.changes > 0;
    }).immediate();
  }

  /**
   * Withdraws an announcement, so the event can be announced again.
   *
   * Claiming has to happen before the work, or two passes could run the same event at once;
   * but an event that could not be dispatched at all — a configuration that would not resolve,
   * a resource that could not be created — has not happened, and a spent claim would mean it
   * never does. Withdrawing puts it back for the next pass to try.
   */
  releaseLifecycleEvent(subjectType: LifecycleEventSubject, subjectId: string, event: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      DELETE FROM lifecycle_event_dispatches
      WHERE subject_type = ? AND subject_id = ? AND event = ?
    `).run(subjectType, subjectId, event).changes === 1;
  }

  listRepositories(workspaceId?: string): RepositoryRecord[] {
    this.#assertOpen();
    const rows = workspaceId === undefined
      ? this.#database.prepare('SELECT * FROM repositories ORDER BY main_root, id').all()
      : this.#database
        .prepare('SELECT * FROM repositories WHERE workspace_id = ? ORDER BY main_root, id')
        .all(workspaceId);
    return (rows as RepositoryRow[]).map(repositoryFromRow);
  }

  listWorktrees(repositoryId?: string): WorktreeRecord[] {
    this.#assertOpen();
    const rows = repositoryId === undefined
      ? this.#database.prepare('SELECT * FROM worktrees ORDER BY path, id').all()
      : this.#database
        .prepare('SELECT * FROM worktrees WHERE repository_id = ? ORDER BY path, id')
        .all(repositoryId);
    return (rows as WorktreeRow[]).map(worktreeFromRow);
  }

  upsertAdapterTrust(input: AdapterTrustInput): AdapterTrustRecord {
    this.#assertOpen();
    if (input.adapterId.trim() === '' || input.canonicalPath.trim() === '' || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new TypeError('Adapter trust record is invalid');
    }
    return this.transaction(() => {
      const trustedAt = new Date().toISOString();
      this.#database.prepare(`
        INSERT INTO adapter_trust (adapter_id, canonical_path, sha256, trusted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (adapter_id, canonical_path) DO UPDATE SET
          sha256 = excluded.sha256,
          trusted_at = excluded.trusted_at
      `).run(input.adapterId, input.canonicalPath, input.sha256, trustedAt);
      const row = this.#database.prepare(`
        SELECT * FROM adapter_trust WHERE adapter_id = ? AND canonical_path = ?
      `).get(input.adapterId, input.canonicalPath) as AdapterTrustRow;
      return adapterTrustFromRow(row);
    });
  }

  listAdapterTrust(): AdapterTrustRecord[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM adapter_trust ORDER BY adapter_id, canonical_path
    `).all() as AdapterTrustRow[];
    return rows.map(adapterTrustFromRow);
  }

  upsertResourceSandbox(input: ResourceSandboxInput): void {
    this.#assertOpen();
    this.transaction(() => {
      const existing = this.#database.prepare(`
        SELECT root, generation, dev, ino, uid FROM resource_sandboxes WHERE id = ?
      `).get(input.id) as Omit<ResourceSandboxInput, 'id'> | undefined;
      if (existing !== undefined) {
        if (
          existing.root !== input.root
          || existing.generation !== input.generation
          || existing.dev !== input.dev
          || existing.ino !== input.ino
          || existing.uid !== input.uid
        ) throw new Error('Resource sandbox identity changed for an existing generation');
        return;
      }
      this.#database.prepare(`
        INSERT INTO resource_sandboxes (id, root, generation, dev, ino, uid, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.root, input.generation, input.dev, input.ino, input.uid, new Date().toISOString());
    });
  }

  registerResourceStorageObject(input: ResourceStorageObjectInput): void {
    this.#assertOpen();
    this.#database.prepare(`
      INSERT INTO resource_storage_objects (
        id, sandbox_id, path, dev, ino, uid, kind, state, retention, owned,
        created_at, last_used_at, last_verified_at, logical_bytes, allocated_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.sandboxId, input.path, input.dev, input.ino, input.uid,
      input.kind, input.state, input.retention, input.owned ? 1 : 0,
      input.createdAt, input.lastUsedAt, input.lastVerifiedAt, input.logicalBytes, input.allocatedBytes,
    );
  }

  addResourceReference(input: ResourceReferenceInput): void {
    this.#assertOpen();
    this.transaction(() => {
      const blocked = this.#database.prepare(`
        SELECT 1 FROM resource_storage_objects o
        WHERE o.id = ? AND (
          o.state IN ('QUARANTINED', 'REMOVED') OR EXISTS (
            SELECT 1 FROM resource_cleanup_leases l WHERE l.storage_object_id = o.id
          )
        )
      `).get(input.storageObjectId);
      if (blocked !== undefined) throw new Error('Resource reference cannot be acquired during or after cleanup');
      this.#database.prepare(`
        INSERT INTO resource_references (
          id, storage_object_id, owner_type, owner_id, resource_name, created_at, released_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(input.id, input.storageObjectId, input.ownerType, input.ownerId, input.resourceName, input.createdAt);
    });
  }

  releaseResourceReference(id: string, releasedAt: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      UPDATE resource_references SET released_at = ? WHERE id = ? AND released_at IS NULL
    `).run(releasedAt, id).changes === 1;
  }

  listResourceGcEvidence(_now?: string): ResourceGcEvidenceRecord[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT o.*, s.root AS sandbox_root, s.generation AS sandbox_generation,
        s.dev AS sandbox_dev, s.ino AS sandbox_ino, s.uid AS sandbox_uid,
        COUNT(r.id) AS reference_count, l.token AS cleanup_lease_token
      FROM resource_storage_objects o
      JOIN resource_sandboxes s ON s.id = o.sandbox_id
      LEFT JOIN resource_references r ON r.storage_object_id = o.id AND r.released_at IS NULL
      LEFT JOIN resource_cleanup_leases l ON l.storage_object_id = o.id
        AND julianday(l.expires_at) > julianday('now')
      GROUP BY o.id
      ORDER BY o.path, o.id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      storageObjectId: row.id as string,
      sandboxId: row.sandbox_id as string,
      path: row.path as string,
      dev: row.dev as number,
      ino: row.ino as number,
      uid: row.uid as number,
      kind: row.kind as ResourceStorageObjectInput['kind'],
      state: row.state as ResourceStorageObjectInput['state'],
      retention: row.retention as ResourceStorageObjectInput['retention'],
      owned: row.owned === 1,
      createdAt: row.created_at as string,
      lastUsedAt: row.last_used_at as string,
      lastVerifiedAt: row.last_verified_at as string,
      logicalBytes: row.logical_bytes as number,
      allocatedBytes: row.allocated_bytes as number,
      sandboxRoot: row.sandbox_root as string,
      sandboxGeneration: row.sandbox_generation as string,
      sandboxDev: row.sandbox_dev as number,
      sandboxIno: row.sandbox_ino as number,
      sandboxUid: row.sandbox_uid as number,
      referenceCount: row.reference_count as number,
      cleanupLeaseToken: row.cleanup_lease_token as string | null,
    }));
  }

  acquireResourceCleanupLease(
    input: ResourceCleanupLeaseRequest,
    token: string,
    ttlMs = 5 * 60_000,
  ): boolean {
    this.#assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    return this.transaction(() => {
      this.#database.prepare(`
        DELETE FROM resource_cleanup_leases
        WHERE storage_object_id = ? AND julianday(expires_at) <= julianday('now')
      `).run(input.storageObjectId);
      const eligible = this.#database.prepare(`
        SELECT o.id FROM resource_storage_objects o
        JOIN resource_sandboxes s ON s.id = o.sandbox_id
        WHERE o.id = ? AND o.sandbox_id = ? AND s.generation = ?
          AND o.path = ? AND o.dev = ? AND o.ino = ? AND o.uid = ? AND o.kind = ?
          AND o.state = ? AND o.retention = ?
          AND o.owned = 1 AND o.retention = 'ephemeral'
          AND o.state IN ('STALE', 'ORPHANED', 'QUARANTINED')
          AND NOT EXISTS (
            SELECT 1 FROM resource_references r
            WHERE r.storage_object_id = o.id AND r.released_at IS NULL
          )
      `).get(
        input.storageObjectId, input.sandboxId, input.sandboxGeneration,
        input.path, input.dev, input.ino, input.uid, input.kind, input.state, input.retention,
      );
      if (eligible === undefined) return false;
      try {
        this.#database.prepare(`
          INSERT INTO resource_cleanup_leases (
            storage_object_id, token, sandbox_id, sandbox_generation, path, dev, ino, uid,
            kind, previous_state, retention, acquired_at, expires_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            strftime('%Y-%m-%dT%H:%M:%fZ', julianday('now') + (? / 86400000.0))
          )
        `).run(
          input.storageObjectId, token, input.sandboxId, input.sandboxGeneration, input.path,
          input.dev, input.ino, input.uid, input.kind, input.state, input.retention, ttlMs,
        );
        this.#database.prepare(`
          UPDATE resource_storage_objects SET state = 'QUARANTINED' WHERE id = ?
        `).run(input.storageObjectId);
        return true;
      } catch (error) {
        if (isConstraintError(error)) return false;
        throw error;
      }
    });
  }

  renewResourceCleanupLease(input: ResourceCleanupLeaseRequest, token: string, ttlMs = 5 * 60_000): boolean {
    this.#assertOpen();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    return this.#database.prepare(`
      UPDATE resource_cleanup_leases SET expires_at =
        strftime('%Y-%m-%dT%H:%M:%fZ', julianday('now') + (? / 86400000.0))
      WHERE storage_object_id = ? AND token = ? AND sandbox_id = ? AND sandbox_generation = ?
        AND path = ? AND dev = ? AND ino = ? AND uid = ? AND kind = ? AND retention = ?
        AND julianday(expires_at) > julianday('now')
        AND EXISTS (
          SELECT 1 FROM resource_storage_objects o
          JOIN resource_sandboxes s ON s.id = o.sandbox_id
          WHERE o.id = resource_cleanup_leases.storage_object_id
            AND o.sandbox_id = resource_cleanup_leases.sandbox_id
            AND s.generation = resource_cleanup_leases.sandbox_generation
            AND o.path = resource_cleanup_leases.path AND o.dev = resource_cleanup_leases.dev
            AND o.ino = resource_cleanup_leases.ino AND o.uid = resource_cleanup_leases.uid
            AND o.kind = resource_cleanup_leases.kind AND o.retention = resource_cleanup_leases.retention
            AND o.state = 'QUARANTINED' AND o.owned = 1
            AND NOT EXISTS (
              SELECT 1 FROM resource_references r
              WHERE r.storage_object_id = o.id AND r.released_at IS NULL
            )
        )
    `).run(
      ttlMs, input.storageObjectId, token, input.sandboxId, input.sandboxGeneration,
      input.path, input.dev, input.ino, input.uid, input.kind, input.retention,
    ).changes === 1;
  }

  releaseResourceCleanupLease(storageObjectId: string, token: string, preserveReservation = false): boolean {
    this.#assertOpen();
    return this.transaction(() => this.#releaseResourceCleanupLease(
      storageObjectId,
      token,
      preserveReservation,
    ));
  }

  finalizeResourceCleanup(storageObjectId: string, token: string): boolean {
    this.#assertOpen();
    return this.transaction(() => {
      const updated = this.#database.prepare(`
        UPDATE resource_storage_objects SET state = 'REMOVED'
        WHERE id = ? AND owned = 1 AND retention = 'ephemeral' AND state = 'QUARANTINED' AND EXISTS (
          SELECT 1 FROM resource_cleanup_leases l
          JOIN resource_sandboxes s ON s.id = resource_storage_objects.sandbox_id
          WHERE l.storage_object_id = resource_storage_objects.id AND l.token = ?
            AND l.sandbox_id = resource_storage_objects.sandbox_id
            AND l.sandbox_generation = s.generation
            AND l.path = resource_storage_objects.path AND l.dev = resource_storage_objects.dev
            AND l.ino = resource_storage_objects.ino AND l.uid = resource_storage_objects.uid
            AND l.kind = resource_storage_objects.kind AND l.retention = resource_storage_objects.retention
            AND julianday(l.expires_at) > julianday('now')
        ) AND NOT EXISTS (
          SELECT 1 FROM resource_references r
          WHERE r.storage_object_id = resource_storage_objects.id AND r.released_at IS NULL
        )
      `).run(storageObjectId, token).changes === 1;
      if (!updated) return false;
      this.#releaseResourceCleanupLease(storageObjectId, token);
      return true;
    });
  }

  finalizeResourceCleanupJournal(input: ResourceGcJournalInput, token: string): boolean {
    this.#assertOpen();
    if (input.phase !== 'finalized') throw new Error('Atomic resource cleanup finalization requires finalized journal evidence');
    return this.transaction(() => {
      const row = this.#database.prepare(`
        SELECT * FROM resource_gc_journal WHERE operation_id = ?
      `).get(input.operationId) as Record<string, unknown> | undefined;
      if (row === undefined || !journalRowMatchesFinalization(row, input)
        || (row.phase !== 'prepared' && row.phase !== 'deleted' && row.phase !== 'finalized')) return false;

      const updated = this.#database.prepare(`
        UPDATE resource_storage_objects SET state = 'REMOVED'
        WHERE id = ? AND sandbox_id = ? AND path = ? AND dev = ? AND ino = ? AND uid = ? AND kind = ?
          AND owned = 1 AND retention = 'ephemeral' AND state = 'QUARANTINED'
          AND EXISTS (
            SELECT 1 FROM resource_sandboxes s
            WHERE s.id = resource_storage_objects.sandbox_id AND s.generation = ?
          )
          AND EXISTS (
            SELECT 1 FROM resource_cleanup_leases l
            WHERE l.storage_object_id = resource_storage_objects.id AND l.token = ?
              AND l.sandbox_id = resource_storage_objects.sandbox_id AND l.sandbox_generation = ?
              AND l.path = resource_storage_objects.path AND l.dev = resource_storage_objects.dev
              AND l.ino = resource_storage_objects.ino AND l.uid = resource_storage_objects.uid
              AND l.kind = resource_storage_objects.kind AND l.retention = resource_storage_objects.retention
              AND julianday(l.expires_at) > julianday('now')
          )
          AND NOT EXISTS (
            SELECT 1 FROM resource_references r
            WHERE r.storage_object_id = resource_storage_objects.id AND r.released_at IS NULL
          )
      `).run(
        input.storageObjectId, input.sandboxId, input.originalPath, input.dev, input.ino, input.uid, input.kind,
        input.sandboxGeneration, token, input.sandboxGeneration,
      ).changes === 1;

      if (!updated) {
        const alreadyRemoved = this.#database.prepare(`
          SELECT 1 FROM resource_storage_objects o
          JOIN resource_sandboxes s ON s.id = o.sandbox_id
          WHERE o.id = ? AND o.sandbox_id = ? AND s.generation = ?
            AND o.path = ? AND o.dev = ? AND o.ino = ? AND o.uid = ? AND o.kind = ?
            AND o.owned = 1 AND o.retention = 'ephemeral' AND o.state = 'REMOVED'
            AND NOT EXISTS (
              SELECT 1 FROM resource_references r
              WHERE r.storage_object_id = o.id AND r.released_at IS NULL
            )
        `).get(
          input.storageObjectId, input.sandboxId, input.sandboxGeneration,
          input.originalPath, input.dev, input.ino, input.uid, input.kind,
        );
        if (alreadyRemoved === undefined) return false;
      }

      const journalUpdated = this.#database.prepare(`
        UPDATE resource_gc_journal SET phase = 'finalized', updated_at = ?
        WHERE operation_id = ? AND phase = ?
      `).run(new Date().toISOString(), input.operationId, row.phase).changes === 1;
      if (!journalUpdated) throw new Error('Atomic resource cleanup journal finalization lost its exact row');
      this.#database.prepare(`
        DELETE FROM resource_cleanup_leases WHERE storage_object_id = ? AND token = ?
      `).run(input.storageObjectId, token);
      return true;
    });
  }

  recordResourceGcJournal(input: ResourceGcJournalInput): void {
    this.#assertOpen();
    const order = { prepared: 0, linked: 1, unlinking: 2, quarantined: 3, deleting: 4, deleted: 5, finalized: 6 } as const;
    const current = this.#database.prepare(`
      SELECT phase FROM resource_gc_journal WHERE operation_id = ?
    `).get(input.operationId) as { phase: ResourceGcJournalInput['phase'] } | undefined;
    if (current !== undefined && order[input.phase] < order[current.phase]) {
      throw new Error('Resource GC journal phase may not move backward');
    }
    this.#database.prepare(`
      INSERT INTO resource_gc_journal (
        operation_id, storage_object_id, phase, original_path, quarantine_path,
        quarantine_container_path, quarantine_container_dev, quarantine_container_ino,
        quarantine_container_uid, quarantine_container_mode,
        dev, ino, uid, sandbox_id, sandbox_generation, kind, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (operation_id) DO UPDATE SET
        phase = excluded.phase, quarantine_path = excluded.quarantine_path,
        quarantine_container_path = excluded.quarantine_container_path,
        quarantine_container_dev = excluded.quarantine_container_dev,
        quarantine_container_ino = excluded.quarantine_container_ino,
        quarantine_container_uid = excluded.quarantine_container_uid,
        quarantine_container_mode = excluded.quarantine_container_mode,
        updated_at = excluded.updated_at
    `).run(
      input.operationId, input.storageObjectId, input.phase, input.originalPath,
      input.quarantinePath,
      input.quarantineContainer?.path ?? null, input.quarantineContainer?.dev ?? null,
      input.quarantineContainer?.ino ?? null, input.quarantineContainer?.uid ?? null,
      input.quarantineContainer?.mode ?? null,
      input.dev, input.ino, input.uid, input.sandboxId,
      input.sandboxGeneration, input.kind, new Date().toISOString(),
    );
  }

  listResourceGcJournal(): ResourceGcJournalInput[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`
      SELECT * FROM resource_gc_journal ORDER BY updated_at, operation_id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      operationId: row.operation_id as string,
      storageObjectId: row.storage_object_id as string,
      phase: row.phase as ResourceGcJournalInput['phase'],
      originalPath: row.original_path as string,
      quarantinePath: row.quarantine_path as string | null,
      dev: row.dev as number,
      ino: row.ino as number,
      uid: row.uid as number,
      sandboxId: row.sandbox_id as string,
      sandboxGeneration: row.sandbox_generation as string,
      kind: row.kind as ResourceStorageObjectInput['kind'],
      quarantineContainer: row.quarantine_container_path === null ? null : {
        path: row.quarantine_container_path as string,
        dev: row.quarantine_container_dev as number,
        ino: row.quarantine_container_ino as number,
        uid: row.quarantine_container_uid as number,
        mode: row.quarantine_container_mode as number,
      },
    }));
  }

  allocateEndpoint(input: EndpointRequest, probe?: EndpointAvailabilityProbe): EndpointLease {
    this.#assertOpen();
    this.#validateEndpointRequest(input);
    return this.transaction(() => {
      const worktree = this.#database
        .prepare('SELECT id FROM worktrees WHERE id = ?')
        .get(input.worktreeId) as { id: string } | undefined;
      if (worktree === undefined) throw new Error(`Unknown worktree: ${input.worktreeId}`);

      const existing = this.#database.prepare(`
        SELECT * FROM endpoint_leases WHERE worktree_id = ? AND name = ?
      `).get(input.worktreeId, input.name) as EndpointRow | undefined;
      const existingIsCompatible = existing?.state === 'ACTIVE'
        && existing.protocol === input.protocol
        && existing.host === input.host;
      if (
        existingIsCompatible
        && (probe === undefined || probe({ protocol: input.protocol, host: input.host, port: existing.port }))
      ) {
        return endpointFromRow(existing);
      }

      const candidates: number[] = [];
      if (
        input.preferredPort !== undefined
        && input.preferredPort >= input.portRange.min
        && input.preferredPort <= input.portRange.max
      ) {
        candidates.push(input.preferredPort);
      }
      for (let port = input.portRange.min; port <= input.portRange.max; port += 1) {
        if (port !== input.preferredPort) candidates.push(port);
      }

      const collisionStatement = this.#database.prepare(`
        SELECT id FROM endpoint_leases
        WHERE protocol = ? AND port = ? AND state = 'ACTIVE' AND id <> ?
      `);
      // Every probe costs a process, so the search is bounded. The default range is thirty
      // thousand ports wide, and a probe that systematically answers "taken" — a throttled
      // daemon whose prober outlives its own timeout, a probe that cannot run at all — turned
      // one allocation into thirty thousand spawns that never finished. Ports already leased
      // are rejected by the statement above and cost nothing, so they do not count.
      let probed = 0;
      let exhausted = false;
      const port = candidates.find((candidate) => {
        if (exhausted) return false;
        if (collisionStatement.get(input.protocol, candidate, existing?.id ?? '') !== undefined) return false;
        if (probe === undefined) return true;
        if (probed >= maxProbedEndpointCandidates) {
          exhausted = true;
          return false;
        }
        probed += 1;
        return probe({ protocol: input.protocol, host: input.host, port: candidate });
      });
      if (port === undefined) {
        const where = `on ${input.host} in range ${input.portRange.min}-${input.portRange.max}`;
        throw new Error(exhausted
          ? `No available ${input.protocol} endpoint ${where}: ${probed} ports were offered and every one was refused.`
          : `No available ${input.protocol} endpoint ${where}`);
      }

      const timestamp = new Date().toISOString();
      if (existing !== undefined) {
        this.#database.prepare(`
          UPDATE endpoint_leases SET
            protocol = ?, host = ?, port = ?, state = 'ACTIVE',
            allocated_at = ?, last_verified_at = ?
          WHERE id = ?
        `).run(input.protocol, input.host, port, timestamp, timestamp, existing.id);
        const row = this.#database
          .prepare('SELECT * FROM endpoint_leases WHERE id = ?')
          .get(existing.id) as EndpointRow;
        return endpointFromRow(row);
      }

      const id = randomUUID();
      this.#database.prepare(`
        INSERT INTO endpoint_leases (
          id, worktree_id, name, protocol, host, port, state, allocated_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(
        id,
        input.worktreeId,
        input.name,
        input.protocol,
        input.host,
        port,
        timestamp,
        timestamp,
      );
      const row = this.#database
        .prepare('SELECT * FROM endpoint_leases WHERE id = ?')
        .get(id) as EndpointRow;
      return endpointFromRow(row);
    });
  }

  listEndpointLeases(query: EndpointLeaseQuery = {}): EndpointLease[] {
    this.#assertOpen();
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (query.worktreeIds !== undefined) {
      if (query.worktreeIds.length === 0) return [];
      conditions.push(`worktree_id IN (${query.worktreeIds.map(() => '?').join(', ')})`);
      parameters.push(...query.worktreeIds);
    }
    if (query.name !== undefined) {
      conditions.push('name = ?');
      parameters.push(query.name);
    }
    if (query.states !== undefined) {
      if (query.states.length === 0) return [];
      conditions.push(`state IN (${query.states.map(() => '?').join(', ')})`);
      parameters.push(...query.states);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const rows = this.#database
      .prepare(`SELECT * FROM endpoint_leases${where} ORDER BY name, port`)
      .all(...parameters) as EndpointRow[];
    return rows.map(endpointFromRow);
  }

  /**
   * Gives back every port one worktree holds, and says how many it gave back.
   *
   * Reconciliation already releases the ports of a worktree Git no longer reports, but that
   * is one pass too late for a removal: the release has to be verifiable *before* Git deletes
   * the directory, or a removal that failed afterwards would leave ports leased to a path
   * that is gone. Releasing twice is not an error, it is zero rows.
   */
  releaseEndpointLeasesForWorktree(worktreeId: string, releasedAt: string): number {
    this.#assertOpen();
    return this.transaction(() => this.#database.prepare(`
      UPDATE endpoint_leases SET state = 'RELEASED', last_verified_at = ?
      WHERE worktree_id = ? AND state = 'ACTIVE'
    `).run(releasedAt, worktreeId).changes);
  }

  createManagedProcess(
    input: ManagedProcessInput,
    options: ManagedProcessCreateOptions = {},
  ): ManagedProcessRecord {
    this.#assertOpen();
    this.#validateManagedProcess(input);
    return this.transaction(() => {
      if (options.reservationToken !== undefined) {
        const reservation = this.#database.prepare(`
          SELECT token FROM managed_process_start_reservations
          WHERE worktree_id = ? AND task_name = ?
        `).get(input.worktreeId, input.taskName) as { token: string } | undefined;
        if (reservation?.token !== options.reservationToken) {
          throw new Error('Managed process start reservation is not owned by this caller');
        }
      }
      if (isActiveProcessState(input.state)) {
        const active = this.findActiveManagedProcess(input.worktreeId, input.taskName);
        if (active !== null) {
          throw new Error(`Managed task is already active: ${input.taskName}`);
        }
      }
      const id = randomUUID();
      this.#database.prepare(`
        INSERT INTO managed_processes (
          id, worktree_id, task_name, pid, pgid, process_start_time, command_fingerprint,
          state, started_at, stopped_at, stdout_path, stderr_path
          , cleanup_required, cleanup_owner_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.worktreeId,
        input.taskName,
        input.pid,
        input.pgid,
        input.processStartTime,
        input.commandFingerprint,
        input.state,
        input.startedAt,
        input.stoppedAt,
        input.stdoutPath,
        input.stderrPath,
        input.cleanupRequired === true ? 1 : 0,
        input.cleanupOwnerToken ?? null,
      );
      return this.#managedProcessById(id);
    });
  }

  getManagedProcess(id: string): ManagedProcessRecord | null {
    this.#assertOpen();
    const row = this.#database
      .prepare('SELECT * FROM managed_processes WHERE id = ?')
      .get(id) as ManagedProcessRow | undefined;
    return row === undefined ? null : managedProcessFromRow(row);
  }

  updateManagedProcess(id: string, update: ManagedProcessUpdate): ManagedProcessRecord | null {
    this.#assertOpen();
    if (update.expectedStates.length === 0) throw new TypeError('Expected managed process states must not be empty');
    for (const expected of update.expectedStates) assertProcessTransition(expected, update.state);
    validateProcessTimestamp(update.state, update.stoppedAt ?? null);
    const placeholders = update.expectedStates.map(() => '?').join(', ');
    return this.transaction(() => {
      const current = this.#managedProcessById(id);
      if (update.reservationToken !== undefined) {
        const reservation = this.#database.prepare(`
          SELECT token FROM managed_process_start_reservations
          WHERE worktree_id = ? AND task_name = ?
        `).get(current.worktreeId, current.taskName) as { token: string } | undefined;
        if (reservation?.token !== update.reservationToken) {
          throw new Error('Managed process start reservation is not owned by this caller');
        }
      }
      const result = this.#database.prepare(`
        UPDATE managed_processes SET state = ?, stopped_at = ?,
          cleanup_required = COALESCE(?, cleanup_required)
        WHERE id = ? AND state IN (${placeholders})
      `).run(
        update.state,
        update.stoppedAt ?? null,
        update.cleanupRequired === undefined ? null : update.cleanupRequired ? 1 : 0,
        id,
        ...update.expectedStates,
      );
      if (result.changes !== 1) return null;
      return this.#managedProcessById(id);
    });
  }

  reserveManagedProcessStart(
    worktreeId: string,
    taskName: string,
    token: string,
    createdAt: string,
    options: ManagedProcessReservationOptions = {},
  ): boolean {
    this.#assertOpen();
    if (token.length === 0) throw new TypeError('Managed process reservation token must not be empty');
    return this.transaction(() => {
      this.#database.prepare(`
        DELETE FROM managed_process_start_reservations
        WHERE worktree_id = ? AND task_name = ? AND expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM managed_processes
            WHERE worktree_id = ? AND task_name = ?
              AND (state IN ('STARTING', 'RUNNING', 'STOPPING') OR cleanup_required = 1)
          )
      `).run(worktreeId, taskName, createdAt, worktreeId, taskName);
      const active = this.findActiveManagedProcess(worktreeId, taskName);
      if (active !== null && options.replaceProcessId !== active.id) return false;
      try {
        this.#database.prepare(`
          INSERT INTO managed_process_start_reservations (
            worktree_id, task_name, token, created_at, expires_at, replace_process_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          worktreeId,
          taskName,
          token,
          createdAt,
          options.expiresAt ?? createdAt,
          options.replaceProcessId ?? null,
        );
        return true;
      } catch (error) {
        if (isConstraintError(error)) return false;
        throw error;
      }
    });
  }

  releaseManagedProcessStart(worktreeId: string, taskName: string, token: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      DELETE FROM managed_process_start_reservations
      WHERE worktree_id = ? AND task_name = ? AND token = ?
    `).run(worktreeId, taskName, token).changes === 1;
  }

  releaseExpiredManagedProcessStart(worktreeId: string, taskName: string, now: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      DELETE FROM managed_process_start_reservations
      WHERE worktree_id = ? AND task_name = ? AND expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM managed_processes
          WHERE worktree_id = ? AND task_name = ?
            AND (state IN ('STARTING', 'RUNNING', 'STOPPING') OR cleanup_required = 1)
        )
    `).run(worktreeId, taskName, now, worktreeId, taskName).changes === 1;
  }

  releaseExpiredManagedProcessReplacement(record: ManagedProcessRecord, now: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      DELETE FROM managed_process_start_reservations
      WHERE worktree_id = ? AND task_name = ? AND expires_at <= ?
        AND replace_process_id = ?
        AND EXISTS (
          SELECT 1 FROM managed_processes
          WHERE id = ? AND worktree_id = ? AND task_name = ?
            AND pid = ? AND pgid = ? AND process_start_time = ? AND command_fingerprint = ?
            AND state = 'RUNNING' AND cleanup_required = 0
        )
    `).run(
      record.worktreeId, record.taskName, now, record.id,
      record.id, record.worktreeId, record.taskName, record.pid, record.pgid,
      record.processStartTime, record.commandFingerprint,
    ).changes === 1;
  }

  hasManagedProcessStartReservation(worktreeId: string, taskName: string): boolean {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT 1 FROM managed_process_start_reservations
      WHERE worktree_id = ? AND task_name = ?
    `).get(worktreeId, taskName) !== undefined;
  }

  /**
   * Claims a repository for one destructive operation, or reports who is already doing it.
   *
   * The primary key is the repository and the operation, so the insert conflict *is* the
   * refusal — the same shape as a managed process start reservation, and for the same reason:
   * two processes asking at once cannot both be told yes.
   */
  acquireRepositoryOperationLease(
    input: RepositoryOperationLeaseRequest,
    now: string,
  ): RepositoryOperationLeaseResult {
    this.#assertOpen();
    if (input.token.length === 0) throw new TypeError('Repository operation lease token must not be empty');
    if (!Number.isSafeInteger(input.pid) || input.pid < 1) {
      throw new RangeError('Repository operation lease PID must be positive');
    }
    if (input.processStartTime.length === 0) {
      throw new TypeError('Repository operation lease owner identity must be complete');
    }
    const expiresAt = repositoryOperationLeaseExpiry(now, input.ttlMs);
    return this.transaction(() => {
      const existing = this.#repositoryOperationLease(input);
      if (existing !== null) {
        // A lapsed TTL is not evidence that the holder is gone — a `git worktree remove` on a
        // cold filesystem outlives a TTL and is still the safest thing in the room. Stealing
        // the lease from it would put two processes inside the same destruction.
        if (!isRepositoryOperationLeaseExpired(existing, now)) {
          return { outcome: 'conflict', holder: existing };
        }
        // Liveness is the caller's verdict and costs a `ps`, so it is asked for exactly one
        // row and only once that row has expired. No callback means no evidence of life.
        if ((input.ownerLiveness?.(existing) ?? 'gone') === 'alive') {
          return { outcome: 'conflict', holder: existing };
        }
        // An abandoned lease is reported, not taken: its stage names a half-finished cleanup,
        // and continuing one is only safe for a caller that asked to resume it.
        if (input.adopt !== true) return { outcome: 'abandoned', holder: existing };
        this.#database.prepare(`
          DELETE FROM repository_operation_leases WHERE repository_id = ? AND operation = ?
        `).run(input.repositoryId, input.operation);
      }
      // The stage survives adoption. If the resuming process dies too, the next one still
      // learns how far the first one got.
      const stage = existing?.stage ?? null;
      const subjectWorktreeId = input.subjectWorktreeId ?? existing?.subjectWorktreeId ?? null;
      this.#database.prepare(`
        INSERT INTO repository_operation_leases (
          repository_id, operation, token, pid, process_start_time, subject_worktree_id,
          stage, acquired_at, renewed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.repositoryId, input.operation, input.token, input.pid, input.processStartTime,
        subjectWorktreeId, stage, now, now, expiresAt,
      );
      return {
        outcome: 'acquired',
        lease: {
          repositoryId: input.repositoryId,
          operation: input.operation,
          token: input.token,
          pid: input.pid,
          processStartTime: input.processStartTime,
          subjectWorktreeId,
          stage,
          acquiredAt: now,
          renewedAt: now,
          expiresAt,
        },
        adoptedStage: existing === null ? null : stage,
      };
    });
  }

  /**
   * Extends a lease its holder still owns.
   *
   * An expired lease is not renewable, only re-acquirable: renewing one would let a process
   * that stopped reporting for longer than its TTL reappear and carry on as though nothing
   * had happened, past a liveness check it never had to pass.
   */
  renewRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    now: string,
    ttlMs: number,
  ): boolean {
    this.#assertOpen();
    const expiresAt = repositoryOperationLeaseExpiry(now, ttlMs);
    return this.transaction(() => this.#database.prepare(`
      UPDATE repository_operation_leases SET renewed_at = ?, expires_at = ?
      WHERE repository_id = ? AND operation = ? AND token = ? AND expires_at > ?
    `).run(now, expiresAt, key.repositoryId, key.operation, token, now).changes === 1);
  }

  /**
   * Records the last stage the operation completed, for the holding token only.
   *
   * The row is the journal, so the stage is written where the lock is and cannot disagree
   * with it. Expiry does not gate this: an adopted lease carries a different token, so the
   * token check already keeps a displaced owner from writing over its successor's progress,
   * and a holder that is still working should never lose its journal to a lapsed TTL.
   */
  advanceRepositoryOperationLease(
    key: RepositoryOperationLeaseKey,
    token: string,
    stage: string,
    now: string,
  ): boolean {
    this.#assertOpen();
    if (stage.length === 0) throw new TypeError('Repository operation lease stage must not be empty');
    return this.transaction(() => this.#database.prepare(`
      UPDATE repository_operation_leases SET stage = ?, renewed_at = ?
      WHERE repository_id = ? AND operation = ? AND token = ?
    `).run(stage, now, key.repositoryId, key.operation, token).changes === 1);
  }

  releaseRepositoryOperationLease(key: RepositoryOperationLeaseKey, token: string): boolean {
    this.#assertOpen();
    return this.transaction(() => this.#database.prepare(`
      DELETE FROM repository_operation_leases
      WHERE repository_id = ? AND operation = ? AND token = ?
    `).run(key.repositoryId, key.operation, token).changes === 1);
  }

  /**
   * Who holds this operation, for a diagnostic that has to name them. The token stays in the
   * database: a read is not a capability to release.
   */
  readRepositoryOperationLease(key: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null {
    this.#assertOpen();
    return this.#repositoryOperationLease(key);
  }

  listManagedProcesses(query: ManagedProcessQuery = {}): ManagedProcessRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const parameters: Array<string> = [];
    if (query.worktreeId !== undefined) {
      clauses.push('worktree_id = ?');
      parameters.push(query.worktreeId);
    }
    if (query.taskName !== undefined) {
      clauses.push('task_name = ?');
      parameters.push(query.taskName);
    }
    if (query.states !== undefined) {
      if (query.states.length === 0) return [];
      clauses.push(`state IN (${query.states.map(() => '?').join(', ')})`);
      parameters.push(...query.states);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const rows = this.#database.prepare(`
      SELECT * FROM managed_processes ${where} ORDER BY started_at, id
    `).all(...parameters) as ManagedProcessRow[];
    return rows.map(managedProcessFromRow);
  }

  findActiveManagedProcess(worktreeId: string, taskName: string): ManagedProcessRecord | null {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT * FROM managed_processes
      WHERE worktree_id = ? AND task_name = ?
        AND state IN ('STARTING', 'RUNNING', 'STOPPING')
      ORDER BY started_at DESC, id DESC LIMIT 1
    `).get(worktreeId, taskName) as ManagedProcessRow | undefined;
    return row === undefined ? null : managedProcessFromRow(row);
  }

  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    return this.#database.transaction(fn).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('State store is closed');
  }

  #validateEndpointRequest(input: EndpointRequest): void {
    const { min, max } = input.portRange;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) {
      throw new RangeError('Endpoint port range must contain integers between 1 and 65535');
    }
    if (
      input.preferredPort !== undefined
      && (!Number.isInteger(input.preferredPort) || input.preferredPort < 1 || input.preferredPort > 65535)
    ) {
      throw new RangeError('Preferred endpoint port must be an integer between 1 and 65535');
    }
    if (input.name.length === 0) throw new TypeError('Endpoint name must not be empty');
    if (input.host.length === 0) throw new TypeError('Endpoint host must not be empty');
  }

  #validateManagedProcess(input: ManagedProcessInput): void {
    if (!Number.isSafeInteger(input.pid) || input.pid < 1) throw new RangeError('Managed process PID must be positive');
    if (!Number.isSafeInteger(input.pgid) || input.pgid < 1) throw new RangeError('Managed process PGID must be positive');
    if (input.taskName.length === 0) throw new TypeError('Managed process task name must not be empty');
    if (input.processStartTime.length === 0 || input.commandFingerprint.length === 0) {
      throw new TypeError('Managed process identity must be complete');
    }
    validateProcessTimestamp(input.state, input.stoppedAt);
  }

  #managedProcessById(id: string): ManagedProcessRecord {
    const row = this.#database
      .prepare('SELECT * FROM managed_processes WHERE id = ?')
      .get(id) as ManagedProcessRow | undefined;
    if (row === undefined) throw new Error(`Unknown managed process: ${id}`);
    return managedProcessFromRow(row);
  }

  #repositoryOperationLease(key: RepositoryOperationLeaseKey): RepositoryOperationLeaseHolder | null {
    const row = this.#database.prepare(`
      SELECT * FROM repository_operation_leases WHERE repository_id = ? AND operation = ?
    `).get(key.repositoryId, key.operation) as RepositoryOperationLeaseRow | undefined;
    return row === undefined ? null : repositoryOperationLeaseHolderFromRow(row);
  }

  #releaseResourceCleanupLease(storageObjectId: string, token: string, preserveReservation = false): boolean {
    if (!preserveReservation) this.#database.prepare(`
      UPDATE resource_storage_objects SET state = (
        SELECT previous_state FROM resource_cleanup_leases l
        WHERE l.storage_object_id = resource_storage_objects.id AND l.token = ?
      )
      WHERE id = ? AND state = 'QUARANTINED' AND EXISTS (
        SELECT 1 FROM resource_cleanup_leases l
        WHERE l.storage_object_id = resource_storage_objects.id AND l.token = ?
      )
    `).run(token, storageObjectId, token);
    return this.#database.prepare(`
      DELETE FROM resource_cleanup_leases WHERE storage_object_id = ? AND token = ?
    `).run(storageObjectId, token).changes === 1;
  }

  #migrate(migrationAssets: MigrationAssetProvider): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const migrations = migrationAssets.readMigrations();
    this.#database.transaction(() => {
      const applied = this.#database.prepare('SELECT version FROM schema_migrations WHERE version = ?');
      const record = this.#database.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      );
      for (const [index, migration] of migrations.entries()) {
        const version = index + 1;
        if (applied.get(version) !== undefined) continue;
        this.#database.exec(migration);
        record.run(version, new Date().toISOString());
      }
    }).immediate();
  }
}

function repositoryOperationLeaseExpiry(now: string, ttlMs: number): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('Repository operation lease TTL must be a positive number of milliseconds');
  }
  const acquiredAt = Date.parse(now);
  if (Number.isNaN(acquiredAt)) throw new TypeError(`Repository operation lease timestamp must be a date: ${now}`);
  return new Date(acquiredAt + ttlMs).toISOString();
}

/**
 * Expiry is caller-supplied ISO-8601 TEXT compared with a plain `<=`, exactly as the managed
 * process reservations compare theirs, so that a test can state a timeline instead of racing
 * a wall clock — and so that the two subsystems cannot disagree about what expired means.
 */
function isRepositoryOperationLeaseExpired(holder: RepositoryOperationLeaseHolder, now: string): boolean {
  return holder.expiresAt <= now;
}

function isActiveProcessState(state: ManagedProcessState): boolean {
  return state === 'STARTING' || state === 'RUNNING' || state === 'STOPPING';
}

function validateProcessTimestamp(state: ManagedProcessState, stoppedAt: string | null): void {
  if (isTerminalProcessState(state) && stoppedAt === null) {
    throw new TypeError('Terminal managed process state requires stoppedAt');
  }
  if (!isTerminalProcessState(state) && stoppedAt !== null) {
    throw new TypeError('Nonterminal managed process state requires stoppedAt to be null');
  }
}

function isTerminalProcessState(state: ManagedProcessState): boolean {
  return state === 'STOPPED' || state === 'FAILED' || state === 'STALE_IDENTITY';
}

function assertProcessTransition(from: ManagedProcessState, to: ManagedProcessState): void {
  if (from === to) return;
  const allowed: Record<ManagedProcessState, readonly ManagedProcessState[]> = {
    STARTING: ['RUNNING', 'STOPPING', 'STOPPED', 'FAILED', 'STALE_IDENTITY'],
    RUNNING: ['STOPPING', 'STOPPED', 'FAILED', 'STALE_IDENTITY'],
    STOPPING: ['STOPPED', 'FAILED', 'STALE_IDENTITY'],
    STOPPED: [],
    FAILED: [],
    STALE_IDENTITY: [],
  };
  if (!allowed[from].includes(to)) throw new Error(`Invalid managed process transition: ${from} -> ${to}`);
}

function isConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('SQLITE_CONSTRAINT');
}

function journalRowMatchesFinalization(row: Record<string, unknown>, input: ResourceGcJournalInput): boolean {
  const container = input.quarantineContainer;
  return row.operation_id === input.operationId && row.storage_object_id === input.storageObjectId
    && row.original_path === input.originalPath && row.quarantine_path === input.quarantinePath
    && row.dev === input.dev && row.ino === input.ino && row.uid === input.uid
    && row.sandbox_id === input.sandboxId && row.sandbox_generation === input.sandboxGeneration
    && row.kind === input.kind
    && row.quarantine_container_path === (container?.path ?? null)
    && row.quarantine_container_dev === (container?.dev ?? null)
    && row.quarantine_container_ino === (container?.ino ?? null)
    && row.quarantine_container_uid === (container?.uid ?? null)
    && row.quarantine_container_mode === (container?.mode ?? null);
}
