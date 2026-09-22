import { describe, expect, test } from 'bun:test';
import {
  checklistArgumentSchemas, checklistClearResultSchema, checklistCommandNames,
  checklistItemSchema, checklistListResultSchema, checklistSetResultSchema,
  checklistToggleRequestSchema,
} from '../index';

const item = {
  position: 0, text: 'Check the login flow', checked: false,
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
};

describe('checklist protocol', () => {
  test('declares exactly the daemon-backed checklist commands', () => {
    expect([...checklistCommandNames].sort()).toEqual(['checklist.clear', 'checklist.list', 'checklist.set']);
  });

  test('validates each command\'s arguments and refuses unknown fields', () => {
    expect(checklistArgumentSchemas['checklist.list'].safeParse({ cwd: '/repo' }).success).toBe(true);
    expect(checklistArgumentSchemas['checklist.clear'].safeParse({ cwd: '/repo' }).success).toBe(true);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: ['Check it'] }).success).toBe(true);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: [] }).success).toBe(false);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: ['Check it'], extra: 1 }).success).toBe(false);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({
      cwd: '/repo', items: Array.from({ length: 101 }, (_, index) => `item ${index}`),
    }).success).toBe(false);
  });

  // A whitespace-only item passes the plain `.min(1)` length check on its raw text, then the
  // store trims it away to `""` and drops it -- but `checklist.set` deletes the whole existing
  // list unconditionally before inserting, so this used to silently wipe a checklist down to zero
  // items instead of erroring. See `checklistItemTextSchema`'s own doc comment.
  test('refuses a checklist item that is only whitespace', () => {
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: [' '] }).success).toBe(false);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: ['\t\n'] }).success).toBe(false);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: ['Check it', ' '] }).success).toBe(false);
    expect(checklistArgumentSchemas['checklist.set'].safeParse({ cwd: '/repo', items: [' Check it '] }).success).toBe(true);
  });

  test('validates a checklist item and the per-command results', () => {
    expect(checklistItemSchema.safeParse(item).success).toBe(true);
    expect(checklistItemSchema.safeParse({ ...item, extra: true }).success).toBe(false);
    expect(checklistListResultSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(checklistSetResultSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(checklistClearResultSchema.safeParse({ removed: 2 }).success).toBe(true);
    expect(checklistClearResultSchema.safeParse({ removed: -1 }).success).toBe(false);
  });

  test('the browser toggle request is its own schema, not one of the daemon-socket commands', () => {
    expect(checklistToggleRequestSchema.safeParse({ position: 0, checked: true }).success).toBe(true);
    expect(checklistToggleRequestSchema.safeParse({ position: -1, checked: true }).success).toBe(false);
    expect(checklistToggleRequestSchema.safeParse({ position: 0, checked: true, extra: 1 }).success).toBe(false);
    expect(checklistCommandNames.has('checklist.setChecked')).toBe(false);
  });
});
