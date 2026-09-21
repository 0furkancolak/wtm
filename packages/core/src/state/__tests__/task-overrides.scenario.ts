import type { TaskConfig } from '../../config/schema';
import type { SqliteDatabase } from '../database';
import { stateStoreRuntime } from '../runtime';
import { SQLiteStateStore } from '../sqlite-store';

function open(): SQLiteStateStore {
  return new SQLiteStateStore(':memory:');
}

const devTask: TaskConfig = { run: 'npm run dev', shell: true, cwd: '/repo', background: true };

function setsAndReads() {
  const store = open();
  try {
    const { taskOverrides } = store;
    const created = taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:00.000Z' });
    const fetched = taskOverrides.get('wt-1', 'dev');
    const missing = taskOverrides.get('wt-1', 'build');
    return {
      created: { taskName: created.taskName, task: created.task, createdAt: created.createdAt, updatedAt: created.updatedAt },
      fetchedMatchesCreated: JSON.stringify(fetched) === JSON.stringify(created),
      missingIsNull: missing === null,
    };
  } finally {
    store.close();
  }
}

function setReplacesWholeTaskAndKeepsCreatedAt() {
  const store = open();
  try {
    const { taskOverrides } = store;
    const first = taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:00.000Z' });
    const replacement: TaskConfig = { run: 'npm run dev:v2', shell: true };
    const second = taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: replacement, now: '2026-09-21T12:05:00.000Z' });
    return {
      createdAtUnchanged: second.createdAt === first.createdAt,
      updatedAtAdvanced: second.updatedAt === '2026-09-21T12:05:00.000Z',
      // A field the replacement left out (`cwd`, `background`) does not survive: this is a
      // whole-task replacement, not a field-by-field merge.
      taskIsExactlyReplacement: JSON.stringify(second.task) === JSON.stringify(replacement),
    };
  } finally {
    store.close();
  }
}

function listsOnlyItsOwnWorktree() {
  const store = open();
  try {
    const { taskOverrides } = store;
    taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:00.000Z' });
    taskOverrides.set({ worktreeId: 'wt-1', taskName: 'build', task: { run: 'npm run build', shell: true }, now: '2026-09-21T12:00:01.000Z' });
    taskOverrides.set({ worktreeId: 'wt-2', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:02.000Z' });
    const wt1 = taskOverrides.listForWorktree('wt-1').map(({ taskName }) => taskName);
    const wt2 = taskOverrides.listForWorktree('wt-2').map(({ taskName }) => taskName);
    const wt3 = taskOverrides.listForWorktree('wt-3');
    return { wt1, wt2, wt3Length: wt3.length };
  } finally {
    store.close();
  }
}

function unsetsAndDeletesForWorktree() {
  const store = open();
  try {
    const { taskOverrides } = store;
    taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:00.000Z' });
    taskOverrides.set({ worktreeId: 'wt-1', taskName: 'build', task: devTask, now: '2026-09-21T12:00:01.000Z' });
    const unsetMissing = taskOverrides.unset('wt-1', 'test');
    const unsetDev = taskOverrides.unset('wt-1', 'dev');
    const devIsGone = taskOverrides.get('wt-1', 'dev') === null;
    taskOverrides.set({ worktreeId: 'wt-2', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:02.000Z' });
    const deletedWt1 = taskOverrides.deleteForWorktree('wt-1');
    const wt2Survives = taskOverrides.listForWorktree('wt-2').length;
    return { unsetMissing, unsetDev, devIsGone, deletedWt1, wt2Survives };
  } finally {
    store.close();
  }
}

/** A stored row whose JSON no longer parses (or fails the current `taskSchema`) is dropped, not thrown. */
function dropsUnparseableRow() {
  let database: SqliteDatabase | undefined;
  const store = new SQLiteStateStore(':memory:', {
    databaseFactory: (path, options) => (database = stateStoreRuntime().databaseFactory(path, options)),
  });
  try {
    const { taskOverrides } = store;
    taskOverrides.set({ worktreeId: 'wt-1', taskName: 'dev', task: devTask, now: '2026-09-21T12:00:00.000Z' });
    database!.prepare(`INSERT INTO task_overrides (worktree_id, task_name, task_json, created_at, updated_at)
      VALUES ('wt-1', 'broken-json', '{not json', '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z')`).run();
    database!.prepare(`INSERT INTO task_overrides (worktree_id, task_name, task_json, created_at, updated_at)
      VALUES ('wt-1', 'wrong-shape', '{"unknownField":true}', '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z')`).run();
    return {
      listedNames: taskOverrides.listForWorktree('wt-1').map(({ taskName }) => taskName),
      brokenJsonIsNull: taskOverrides.get('wt-1', 'broken-json') === null,
      wrongShapeIsNull: taskOverrides.get('wt-1', 'wrong-shape') === null,
    };
  } finally {
    store.close();
  }
}

const scenarios: Record<string, () => unknown> = {
  'sets-and-reads': setsAndReads,
  'set-replaces-whole-task-and-keeps-created-at': setReplacesWholeTaskAndKeepsCreatedAt,
  'lists-only-its-own-worktree': listsOnlyItsOwnWorktree,
  'unsets-and-deletes-for-worktree': unsetsAndDeletesForWorktree,
  'drops-unparseable-row': dropsUnparseableRow,
};

const scenarioName = process.argv[2];
const scenario = scenarioName === undefined ? undefined : scenarios[scenarioName];
if (scenario === undefined) throw new Error(`Unknown scenario: ${scenarioName ?? '<missing>'}`);
process.stdout.write(`${JSON.stringify(scenario())}\n`);
