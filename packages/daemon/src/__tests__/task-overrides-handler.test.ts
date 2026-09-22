import { describe, expect, test } from 'bun:test';
import type { StateRegistrationReader, TaskConfig, TaskOverrideRecord, TaskOverrideSetInput, TaskOverrideStore, WorktreeRecord } from '@wtm/core';
import type { IpcRequest } from '@wtm/protocol';
import { TaskOverridesHandler } from '../task-overrides-handler';

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'wt-1', repositoryId: 'repo-1', numericId: 1, path: '/repo/worktree', branch: 'main',
    headOid: 'a'.repeat(40), isMain: true, isLocked: false, state: 'RUNNING',
    createdAt: '2026-09-21T12:00:00.000Z', lastSeenAt: '2026-09-21T12:00:00.000Z', lastRuntimeAt: null,
    ...overrides,
  };
}

/** An in-memory `TaskOverrideStore`: the handler only calls the interface, never SQLite directly. */
function fakeStore(): TaskOverrideStore {
  const rows = new Map<string, TaskOverrideRecord>();
  const key = (worktreeId: string, taskName: string) => `${worktreeId}\u0000${taskName}`;
  return {
    set(input: TaskOverrideSetInput) {
      const existing = rows.get(key(input.worktreeId, input.taskName));
      const record: TaskOverrideRecord = {
        worktreeId: input.worktreeId, taskName: input.taskName, task: input.task,
        createdAt: existing?.createdAt ?? input.now, updatedAt: input.now,
      };
      rows.set(key(input.worktreeId, input.taskName), record);
      return record;
    },
    get(worktreeId, taskName) {
      return rows.get(key(worktreeId, taskName)) ?? null;
    },
    listForWorktree(worktreeId) {
      return [...rows.values()].filter((row) => row.worktreeId === worktreeId).sort((left, right) => left.taskName.localeCompare(right.taskName));
    },
    unset(worktreeId, taskName) {
      return rows.delete(key(worktreeId, taskName));
    },
    deleteForWorktree(worktreeId) {
      let count = 0;
      for (const row of [...rows.values()]) if (row.worktreeId === worktreeId) { rows.delete(key(row.worktreeId, row.taskName)); count += 1; }
      return count;
    },
  };
}

function request(command: string, args: unknown): IpcRequest {
  return { command, arguments: args } as IpcRequest;
}

const devTask: TaskConfig = { run: 'npm run dev', shell: true };

describe('TaskOverridesHandler', () => {
  test('rejects an unknown command and invalid arguments', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const handler = new TaskOverridesHandler({ store: fakeStore(), registration });
    expect(await handler.handle(request('task.nope', { cwd: '/repo/worktree' }))).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_INVALID_REQUEST' }] });
    expect(await handler.handle(request('task.list', {}))).toMatchObject({ ok: false, errors: [{ code: 'WTM_DAEMON_INVALID_REQUEST' }] });
  });

  test('refuses a cwd outside any registered worktree', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [] };
    const handler = new TaskOverridesHandler({ store: fakeStore(), registration });
    expect(await handler.handle(request('task.list', { cwd: '/elsewhere' }))).toMatchObject({
      ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { cwd: '/elsewhere' } }],
    });
  });

  test('set validates the task against the core schema and rejects a cross-field violation', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const handler = new TaskOverridesHandler({ store: fakeStore(), registration });
    // A string `run` without `shell: true` violates `taskSchema`'s cross-field rule.
    const invalid = await handler.handle(request('task.set', { cwd: '/repo/worktree', taskName: 'dev', task: { run: 'npm run dev' } }));
    expect(invalid).toMatchObject({ ok: false, errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  });

  test('set, show, list and unset round-trip through the store', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const store = fakeStore();
    const handler = new TaskOverridesHandler({ store, registration });

    const set = await handler.handle(request('task.set', { cwd: '/repo/worktree', taskName: 'dev', task: devTask }));
    expect(set).toMatchObject({ ok: true, command: 'task.set', data: { task: { taskName: 'dev', task: devTask } } });

    const show = await handler.handle(request('task.show', { cwd: '/repo/worktree', taskName: 'dev' }));
    expect(show).toMatchObject({ ok: true, data: { task: { taskName: 'dev', task: devTask } } });

    const showMissing = await handler.handle(request('task.show', { cwd: '/repo/worktree', taskName: 'build' }));
    expect(showMissing).toMatchObject({ ok: true, data: { task: null } });

    const list = await handler.handle(request('task.list', { cwd: '/repo/worktree' }));
    expect(list).toMatchObject({ ok: true, data: { tasks: [{ taskName: 'dev' }] } });

    const unset = await handler.handle(request('task.unset', { cwd: '/repo/worktree', taskName: 'dev' }));
    expect(unset).toMatchObject({ ok: true, data: { removed: true } });
    expect(store.get('wt-1', 'dev')).toBeNull();

    const unsetAgain = await handler.handle(request('task.unset', { cwd: '/repo/worktree', taskName: 'dev' }));
    expect(unsetAgain).toMatchObject({ ok: true, data: { removed: false } });
  });

  test('a set replaces the whole task, not merging onto the previous row', async () => {
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const handler = new TaskOverridesHandler({ store: fakeStore(), registration });
    await handler.handle(request('task.set', { cwd: '/repo/worktree', taskName: 'dev', task: { run: 'npm run dev', shell: true, cwd: '/repo' } }));
    const second = await handler.handle(request('task.set', { cwd: '/repo/worktree', taskName: 'dev', task: { run: 'npm run dev:v2', shell: true } }));
    expect(second).toMatchObject({ ok: true, data: { task: { task: { run: 'npm run dev:v2', shell: true } } } });
  });

  test('set accepts and round-trips a task\'s idle config', async () => {
    // `idle` previously had no mirror in the wire schema (`taskOverrideValueSchema`), so this
    // request was refused as WTM_DAEMON_INVALID_REQUEST before ever reaching `taskSchema`'s own
    // (correct) validation below.
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree()] };
    const store = fakeStore();
    const handler = new TaskOverridesHandler({ store, registration });
    const task = { run: 'npm run dev', shell: true, idle: { enabled: true, timeout: '10m' } };
    const set = await handler.handle(request('task.set', { cwd: '/repo/worktree', taskName: 'dev', task }));
    expect(set).toMatchObject({ ok: true, data: { task: { taskName: 'dev', task } } });
    expect(store.get('wt-1', 'dev')).toMatchObject({ task });
  });

  test('resolves the deepest matching worktree, ignoring orphaned and removed ones', async () => {
    const nested = worktree({ id: 'wt-nested', path: '/repo/worktree/nested' });
    const removed = worktree({ id: 'wt-removed', path: '/repo/worktree/nested', state: 'REMOVED' });
    const registration: Pick<StateRegistrationReader, 'listWorktrees'> = { listWorktrees: () => [worktree(), removed, nested] };
    const store = fakeStore();
    const handler = new TaskOverridesHandler({ store, registration });
    await handler.handle(request('task.set', { cwd: '/repo/worktree/nested/src', taskName: 'dev', task: devTask }));
    expect(store.get('wt-nested', 'dev')).not.toBeNull();
    expect(store.get('wt-1', 'dev')).toBeNull();
  });
});
