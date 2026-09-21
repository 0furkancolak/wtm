import { describe, expect, test } from 'bun:test';
import type { ChecklistItemRecord, ChecklistStore, StateRegistrationReader, WorktreeRecord } from '@wtm/core';
import type { IpcRequest } from '@wtm/protocol';
import { ChecklistHandler } from '../checklist-handler';

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'wt-1', repositoryId: 'repo-1', numericId: 1, path: '/repo/worktree', branch: 'main',
    headOid: 'a'.repeat(40), isMain: true, isLocked: false, state: 'RUNNING',
    createdAt: '2026-09-21T12:00:00.000Z', lastSeenAt: '2026-09-21T12:00:00.000Z', lastRuntimeAt: null,
    ...overrides,
  };
}

/** An in-memory `ChecklistStore`: the handler only calls the interface, never SQLite directly. */
function fakeStore(): ChecklistStore {
  const rows = new Map<string, ChecklistItemRecord[]>();
  return {
    set(worktreeId, items, now) {
      const records = items.map((text, position) => ({
        worktreeId, position, text, checked: false, createdAt: now, updatedAt: now,
      }));
      rows.set(worktreeId, records);
      return records;
    },
    list(worktreeId) {
      return rows.get(worktreeId) ?? [];
    },
    setChecked(worktreeId, position, checked, now) {
      const list = rows.get(worktreeId) ?? [];
      const index = list.findIndex((item) => item.position === position);
      if (index === -1) return null;
      const updated = { ...list[index]!, checked, updatedAt: now };
      list[index] = updated;
      return updated;
    },
    clear(worktreeId) {
      const count = (rows.get(worktreeId) ?? []).length;
      rows.delete(worktreeId);
      return count;
    },
    deleteForWorktree(worktreeId) {
      const count = (rows.get(worktreeId) ?? []).length;
      rows.delete(worktreeId);
      return count;
    },
  };
}

function request(command: string, args: unknown): IpcRequest {
  return { command, arguments: args } as IpcRequest;
}

describe('ChecklistHandler', () => {
  test('rejects an unknown command and invalid arguments', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const handler = new ChecklistHandler({ store: fakeStore(), registration });
    expect(await handler.handle(request('checklist.nope', { cwd: '/repo/worktree' }))).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_INVALID_REQUEST' }] });
    expect(await handler.handle(request('checklist.list', {}))).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_INVALID_REQUEST' }] });
    expect(await handler.handle(request('checklist.set', { cwd: '/repo/worktree', items: [] }))).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_INVALID_REQUEST' }] });
  });

  test('refuses a cwd outside any registered worktree', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [] };
    const handler = new ChecklistHandler({ store: fakeStore(), registration });
    expect(await handler.handle(request('checklist.list', { cwd: '/elsewhere' }))).toMatchObject({
      ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { cwd: '/elsewhere' } }],
    });
  });

  test('set, list and clear round-trip through the store', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const store = fakeStore();
    const handler = new ChecklistHandler({ store, registration });

    const set = await handler.handle(request('checklist.set', { cwd: '/repo/worktree', items: ['Check login', 'Run migration'] }));
    expect(set).toMatchObject({
      ok: true, command: 'checklist.set',
      data: { items: [{ position: 0, text: 'Check login', checked: false }, { position: 1, text: 'Run migration', checked: false }] },
    });

    const list = await handler.handle(request('checklist.list', { cwd: '/repo/worktree' }));
    expect(list).toMatchObject({ ok: true, data: { items: [{ text: 'Check login' }, { text: 'Run migration' }] } });

    const clear = await handler.handle(request('checklist.clear', { cwd: '/repo/worktree' }));
    expect(clear).toMatchObject({ ok: true, data: { removed: 2 } });
    expect(store.list('wt-1')).toEqual([]);
  });

  test('a second set replaces the whole list, not merging onto the previous one', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const handler = new ChecklistHandler({ store: fakeStore(), registration });
    await handler.handle(request('checklist.set', { cwd: '/repo/worktree', items: ['First', 'Second'] }));
    const second = await handler.handle(request('checklist.set', { cwd: '/repo/worktree', items: ['Only item'] }));
    expect(second).toMatchObject({ ok: true, data: { items: [{ position: 0, text: 'Only item' }] } });
  });

  test('resolves the deepest matching worktree, ignoring orphaned and removed ones', async () => {
    const nested = worktree({ id: 'wt-nested', path: '/repo/worktree/nested' });
    const removed = worktree({ id: 'wt-removed', path: '/repo/worktree/nested', state: 'REMOVED' });
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree(), removed, nested] };
    const store = fakeStore();
    const handler = new ChecklistHandler({ store, registration });
    await handler.handle(request('checklist.set', { cwd: '/repo/worktree/nested/src', items: ['Check it'] }));
    expect(store.list('wt-nested')).not.toEqual([]);
    expect(store.list('wt-1')).toEqual([]);
  });
});
