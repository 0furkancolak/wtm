import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { GitWorktreeRecord } from '../git/worktree-parser';
import type {
  EndpointLease,
  EndpointAvailabilityProbe,
  EndpointRequest,
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

const initialMigration = readFileSync(
  new URL('./migrations/001-initial.sql', import.meta.url),
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

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    this.#database.transaction(() => {
      const row = this.#database
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(1) as { version: number } | undefined;
      if (row !== undefined) return;
      this.#database.exec(initialMigration);
      this.#database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString());
    }).immediate();
  }
}
