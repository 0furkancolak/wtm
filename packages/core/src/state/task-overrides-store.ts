import { taskSchema } from '../config/schema';
import type { TaskOverrideRecord, TaskOverrideStore } from './task-overrides';
import type { SqliteDatabase } from './database';

type Row = Record<string, string | number | null>;

export function createTaskOverrideStore(database: SqliteDatabase): TaskOverrideStore {
  // A row that no longer parses — invalid JSON or a shape an older/newer WTM wrote that this
  // version's `taskSchema` rejects — is dropped rather than failing every read, the same
  // tolerance `ci-store.ts` gives a corrupt `run_json` row.
  const record = (row: Row): TaskOverrideRecord | null => {
    let value: unknown;
    try {
      value = JSON.parse(String(row.task_json));
    } catch {
      return null;
    }
    const parsed = taskSchema.safeParse(value);
    if (!parsed.success) return null;
    return {
      worktreeId: String(row.worktree_id),
      taskName: String(row.task_name),
      task: parsed.data,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  };

  return {
    set(input) {
      const taskJson = JSON.stringify(taskSchema.parse(input.task));
      const existing = database.prepare('SELECT created_at FROM task_overrides WHERE worktree_id = ? AND task_name = ?')
        .get(input.worktreeId, input.taskName) as Row | undefined;
      const createdAt = existing === undefined ? input.now : String(existing.created_at);
      database.prepare(`INSERT INTO task_overrides (worktree_id, task_name, task_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (worktree_id, task_name) DO UPDATE SET task_json = excluded.task_json, updated_at = excluded.updated_at`)
        .run(input.worktreeId, input.taskName, taskJson, createdAt, input.now);
      const record0 = record({
        worktree_id: input.worktreeId, task_name: input.taskName, task_json: taskJson,
        created_at: createdAt, updated_at: input.now,
      });
      if (record0 === null) throw new Error('A task override that was just written failed to parse back.');
      return record0;
    },

    get(worktreeId, taskName) {
      const row = database.prepare('SELECT * FROM task_overrides WHERE worktree_id = ? AND task_name = ?')
        .get(worktreeId, taskName) as Row | undefined;
      return row === undefined ? null : record(row);
    },

    listForWorktree(worktreeId) {
      return (database.prepare('SELECT * FROM task_overrides WHERE worktree_id = ? ORDER BY task_name').all(worktreeId) as Row[])
        .flatMap((row) => {
          const parsed = record(row);
          return parsed === null ? [] : [parsed];
        });
    },

    unset(worktreeId, taskName) {
      return database.prepare('DELETE FROM task_overrides WHERE worktree_id = ? AND task_name = ?')
        .run(worktreeId, taskName).changes > 0;
    },

    deleteForWorktree(worktreeId) {
      return database.prepare('DELETE FROM task_overrides WHERE worktree_id = ?').run(worktreeId).changes;
    },
  };
}
