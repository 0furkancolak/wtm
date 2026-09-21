import type { ChecklistItemRecord, ChecklistStore } from './checklist';
import type { SqliteDatabase } from './database';

type Row = Record<string, string | number | null>;

/** Same cap `checklistArgumentSchemas['checklist.set']`'s `items` array carries in `@wtm/protocol`. */
const maxItems = 100;
const maxTextLength = 500;

export function createChecklistStore(database: SqliteDatabase): ChecklistStore {
  const transaction = <T>(body: () => T): T => database.transaction(body).immediate();
  const record = (row: Row): ChecklistItemRecord => ({
    worktreeId: String(row.worktree_id),
    position: Number(row.position),
    text: String(row.text),
    checked: row.checked === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  const listRows = (worktreeId: string): Row[] =>
    database.prepare('SELECT * FROM checklist_items WHERE worktree_id = ? ORDER BY position').all(worktreeId) as Row[];

  return {
    set(worktreeId, items, now) {
      const trimmed = items.map((item) => item.trim()).filter((item) => item.length > 0).slice(0, maxItems)
        .map((item) => item.slice(0, maxTextLength));
      return transaction(() => {
        database.prepare('DELETE FROM checklist_items WHERE worktree_id = ?').run(worktreeId);
        const insert = database.prepare(`INSERT INTO checklist_items
          (worktree_id, position, text, checked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`);
        trimmed.forEach((text, position) => insert.run(worktreeId, position, text, now, now));
        return listRows(worktreeId).map(record);
      });
    },

    list(worktreeId) {
      return listRows(worktreeId).map(record);
    },

    setChecked(worktreeId, position, checked, now) {
      return transaction(() => {
        const row = database.prepare('SELECT * FROM checklist_items WHERE worktree_id = ? AND position = ?')
          .get(worktreeId, position) as Row | undefined;
        if (row === undefined) return null;
        database.prepare('UPDATE checklist_items SET checked = ?, updated_at = ? WHERE worktree_id = ? AND position = ?')
          .run(checked ? 1 : 0, now, worktreeId, position);
        return record({ ...row, checked: checked ? 1 : 0, updated_at: now });
      });
    },

    clear(worktreeId) {
      return transaction(() => database.prepare('DELETE FROM checklist_items WHERE worktree_id = ?').run(worktreeId).changes);
    },

    deleteForWorktree(worktreeId) {
      return transaction(() => database.prepare('DELETE FROM checklist_items WHERE worktree_id = ?').run(worktreeId).changes);
    },
  };
}
