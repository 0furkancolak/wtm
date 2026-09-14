import { randomUUID } from 'node:crypto';
import { ciRunSchema, type CiRun } from '@wtm/protocol';
import { CiWatchError, type CiWatchRecord, type CiWatchStore } from './ci';
import type { SqliteDatabase } from './database';

type Row = Record<string, string | number | null>;

export function createCiWatchStore(database: SqliteDatabase): CiWatchStore {
  const transaction = <T>(body: () => T): T => database.transaction(body).immediate();
  const runsOf = (watchId: string): CiRun[] => (
    database.prepare('SELECT run_json FROM ci_runs WHERE watch_id = ? ORDER BY position').all(watchId) as Row[]
  ).flatMap((row) => {
    // A row that no longer parses — invalid JSON or the wrong shape — is dropped rather than
    // failing every status read.
    let value: unknown;
    try {
      value = JSON.parse(String(row.run_json));
    } catch {
      return [];
    }
    const parsed = ciRunSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const record = (row: Row): CiWatchRecord => ({
    watchId: String(row.watch_id), repositoryId: String(row.repository_id), worktreeId: String(row.worktree_id),
    worktreePath: String(row.worktree_path), providerRepo: String(row.provider_repo), branch: row.branch as string | null,
    headSha: String(row.head_sha), pr: row.pr == null ? null : Number(row.pr), state: row.state as CiWatchRecord['state'],
    detail: row.detail as string | null, startedAt: String(row.started_at), updatedAt: String(row.updated_at),
    finishedAt: row.finished_at as string | null, nextPollAt: String(row.next_poll_at), pollIntervalMs: Number(row.poll_interval_ms),
    failureStreak: Number(row.failure_streak), sawRuns: row.saw_runs === 1, runs: runsOf(String(row.watch_id)),
  });
  const get = (watchId: string): CiWatchRecord | null => {
    const row = database.prepare('SELECT * FROM ci_watches WHERE watch_id = ?').get(watchId) as Row | undefined;
    return row === undefined ? null : record(row);
  };
  const pendingFor = (worktreeId: string): Row | undefined => (
    database.prepare(`SELECT * FROM ci_watches WHERE worktree_id = ? AND state = 'pending'`).get(worktreeId) as Row | undefined
  );

  return {
    start(input) {
      return transaction(() => {
        const existing = pendingFor(input.worktreeId);
        if (existing !== undefined && existing.head_sha === input.headSha) return { watch: record(existing), reused: true };
        if (existing !== undefined) {
          database.prepare(`UPDATE ci_watches SET state = 'superseded', finished_at = ?, updated_at = ? WHERE watch_id = ?`)
            .run(input.now, input.now, existing.watch_id);
        }
        const pending = Number((database.prepare(`SELECT COUNT(*) AS count FROM ci_watches WHERE state = 'pending'`).get() as Row).count);
        if (pending >= input.maxPending) {
          throw new CiWatchError('WTM_CI_UNAVAILABLE', `${pending} CI watches are already pending.`, { pending });
        }
        const sequence = Number((database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ci_watches').get() as Row).next);
        const watchId = randomUUID();
        database.prepare(`INSERT INTO ci_watches (watch_id, sequence, repository_id, worktree_id, worktree_path, provider_repo, branch,
          head_sha, pr, state, detail, started_at, updated_at, finished_at, next_poll_at, poll_interval_ms, failure_streak, saw_runs)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, ?, ?, 0, 0)`).run(
          watchId, sequence, input.repositoryId, input.worktreeId, input.worktreePath, input.providerRepo, input.branch,
          input.headSha, input.pr, input.now, input.now, input.nextPollAt, input.pollIntervalMs,
        );
        return { watch: get(watchId)!, reused: false };
      });
    },

    get,

    latestForWorktree(worktreeId) {
      const row = database.prepare('SELECT * FROM ci_watches WHERE worktree_id = ? ORDER BY sequence DESC LIMIT 1').get(worktreeId) as Row | undefined;
      return row === undefined ? null : record(row);
    },

    pending() {
      return (database.prepare(`SELECT * FROM ci_watches WHERE state = 'pending' ORDER BY next_poll_at, sequence`).all() as Row[]).map(record);
    },

    update(watchId, update) {
      return transaction(() => {
        const current = get(watchId);
        if (current === null || current.state !== 'pending') return current;
        const state = update.state ?? current.state;
        database.prepare(`UPDATE ci_watches SET state = ?, detail = ?, updated_at = ?, finished_at = ?, next_poll_at = ?,
          poll_interval_ms = ?, failure_streak = ?, saw_runs = ? WHERE watch_id = ?`).run(
          state,
          update.detail === undefined ? current.detail : update.detail,
          update.now,
          state === 'pending' ? null : update.now,
          update.nextPollAt ?? current.nextPollAt,
          update.pollIntervalMs ?? current.pollIntervalMs,
          update.failureStreak ?? current.failureStreak,
          (update.sawRuns ?? current.sawRuns) ? 1 : 0,
          watchId,
        );
        if (update.runs !== undefined) {
          database.prepare('DELETE FROM ci_runs WHERE watch_id = ?').run(watchId);
          const insert = database.prepare('INSERT INTO ci_runs (watch_id, position, run_json) VALUES (?, ?, ?)');
          update.runs.forEach((run, position) => insert.run(watchId, position, JSON.stringify(run)));
        }
        return get(watchId);
      });
    },

    cancelPendingForWorktree(worktreeId, now, detail) {
      return transaction(() => {
        const row = pendingFor(worktreeId);
        if (row === undefined) return null;
        database.prepare(`UPDATE ci_watches SET state = 'cancelled', detail = ?, finished_at = ?, updated_at = ? WHERE watch_id = ?`)
          .run(detail, now, now, row.watch_id);
        return get(String(row.watch_id));
      });
    },

    deleteForWorktree(worktreeId) {
      return transaction(() => database.prepare('DELETE FROM ci_watches WHERE worktree_id = ?').run(worktreeId).changes);
    },

    prune(now, retentionMs) {
      const cutoff = new Date(Date.parse(now) - retentionMs).toISOString();
      return transaction(() => {
        const expired = database.prepare(`DELETE FROM ci_watches WHERE finished_at IS NOT NULL AND finished_at < ?`).run(cutoff).changes;
        const superseded = database.prepare(`DELETE FROM ci_watches WHERE state = 'superseded' AND EXISTS (
          SELECT 1 FROM ci_watches newer WHERE newer.worktree_id = ci_watches.worktree_id AND newer.sequence > ci_watches.sequence
            AND newer.finished_at IS NOT NULL AND newer.state <> 'superseded')`).run().changes;
        return expired + superseded;
      });
    },
  };
}
