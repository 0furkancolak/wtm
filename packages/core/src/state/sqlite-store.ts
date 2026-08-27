import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type {
  EndpointLease,
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
  RepositoryRecord,
  StateStore,
  WorkspaceInput,
  WorkspaceRecord,
  WorktreeRecord,
  WorktreeState,
} from './store';

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

const initialMigration = readFileSync(
  new URL('./migrations/001-initial.sql', import.meta.url),
  'utf8',
);
const managedProcessIndexesMigration = readFileSync(
  new URL('./migrations/002-managed-process-indexes.sql', import.meta.url),
  'utf8',
);
const managedProcessReservationsMigration = readFileSync(
  new URL('./migrations/003-managed-process-reservations.sql', import.meta.url),
  'utf8',
);
const managedProcessReservationLeasesMigration = readFileSync(
  new URL('./migrations/004-managed-process-reservation-leases.sql', import.meta.url),
  'utf8',
);
const managedProcessCleanupOwnershipMigration = readFileSync(
  new URL('./migrations/005-managed-process-cleanup-ownership.sql', import.meta.url),
  'utf8',
);

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

export class SQLiteStateStore implements StateStore {
  readonly #database: Database.Database;
  #closed = false;

  constructor(path: string) {
    this.#database = new Database(path);
    try {
      this.#database.pragma('foreign_keys = ON');
      if (path !== ':memory:' && !path.startsWith('file::memory:')) {
        this.#database.pragma('journal_mode = WAL');
      }
      this.#database.pragma('busy_timeout = 5000');
      this.#migrate();
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
      for (const existing of existingRows.sort(compareWorktreePaths(repository.main_root))) {
        if (presentPaths.has(existing.path) || cleanupOwnedStates.has(existing.state)) continue;
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
      const port = candidates.find((candidate) => {
        if (collisionStatement.get(input.protocol, candidate, existing?.id ?? '') !== undefined) return false;
        return probe?.({ protocol: input.protocol, host: input.host, port: candidate }) ?? true;
      });
      if (port === undefined) {
        throw new Error(
          `No available ${input.protocol} endpoint on ${input.host} in range ${input.portRange.min}-${input.portRange.max}`,
        );
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

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const migrations = [
      initialMigration,
      managedProcessIndexesMigration,
      managedProcessReservationsMigration,
      managedProcessReservationLeasesMigration,
      managedProcessCleanupOwnershipMigration,
    ];
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
