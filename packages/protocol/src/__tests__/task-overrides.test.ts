import { describe, expect, test } from 'bun:test';
import {
  taskOverrideArgumentSchemas, taskOverrideCommandNames, taskOverrideListResultSchema,
  taskOverrideRecordSchema, taskOverrideSetResultSchema, taskOverrideShowResultSchema,
  taskOverrideUnsetResultSchema, taskOverrideValueSchema,
} from '../index';

const record = {
  taskName: 'dev', task: { run: 'npm run dev', shell: true, cwd: '/repo' },
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
};

describe('task override protocol', () => {
  test('declares exactly the daemon-backed task override commands', () => {
    expect([...taskOverrideCommandNames].sort()).toEqual(['task.list', 'task.set', 'task.show', 'task.unset']);
  });

  test('validates each command\'s arguments and refuses unknown fields', () => {
    expect(taskOverrideArgumentSchemas['task.list'].safeParse({ cwd: '/repo' }).success).toBe(true);
    expect(taskOverrideArgumentSchemas['task.show'].safeParse({ cwd: '/repo', taskName: 'dev' }).success).toBe(true);
    expect(taskOverrideArgumentSchemas['task.show'].safeParse({ cwd: '/repo', taskName: '' }).success).toBe(false);
    expect(taskOverrideArgumentSchemas['task.unset'].safeParse({ cwd: '/repo', taskName: 'dev' }).success).toBe(true);
    expect(taskOverrideArgumentSchemas['task.set'].safeParse({
      cwd: '/repo', taskName: 'dev', task: { run: 'npm run dev', shell: true },
    }).success).toBe(true);
    expect(taskOverrideArgumentSchemas['task.set'].safeParse({
      cwd: '/repo', taskName: 'dev', task: { run: 'npm run dev', shell: true }, extra: 1,
    }).success).toBe(false);
  });

  test('accepts every field a wtm.toml task can declare, and refuses an unknown one', () => {
    expect(taskOverrideValueSchema.safeParse({
      description: 'Run the dev server', run: 'npm run dev', shell: true, cwd: '/repo', background: true,
      singleton: true, env: { PORT: '3000' }, timeout: '30s', on_failure: 'warn', requires: ['build'],
      healthcheck: { type: 'http', url: 'http://localhost:{port.web}/health', interval: '1s' },
      idle: { enabled: true, timeout: '10m' },
    }).success).toBe(true);
    expect(taskOverrideValueSchema.safeParse({ run: ['node', 'server.js'] }).success).toBe(true);
    expect(taskOverrideValueSchema.safeParse({ run: ['wrangler', 'dev'], worker_vars: ['API_URL'] }).success).toBe(true);
    expect(taskOverrideValueSchema.safeParse({ run: ['wrangler', 'dev'], worker_vars: ['NOT A NAME'] }).success).toBe(false);
    expect(taskOverrideValueSchema.safeParse({ run: 'npm run dev', shell: true, unknownField: true }).success).toBe(false);
  });

  // `idle` previously drifted out of this wire schema entirely (every other `taskSchema` field
  // has a mirror here) -- a `task.set` carrying it was refused by this `.strict()` schema before
  // core's own validation ever ran. The bounds checked below (an unknown `idle` sub-field
  // refused) are core's `idleSchema` bounds, kept in sync by hand since protocol cannot import
  // from core.
  test('validates idle the same way core\'s idleSchema does', () => {
    expect(taskOverrideValueSchema.safeParse({ run: 'npm run dev', shell: true, idle: {} }).success).toBe(true);
    expect(taskOverrideValueSchema.safeParse({ run: 'npm run dev', shell: true, idle: { enabled: true } }).success).toBe(true);
    expect(taskOverrideValueSchema.safeParse({
      run: 'npm run dev', shell: true, idle: { enabled: true, timeout: '10m', unknownField: true },
    }).success).toBe(false);
    expect(taskOverrideArgumentSchemas['task.set'].safeParse({
      cwd: '/repo', taskName: 'dev', task: { run: 'npm run dev', shell: true, idle: { enabled: true, timeout: '10m' } },
    }).success).toBe(true);
  });

  test('validates a task override record and the per-command results', () => {
    expect(taskOverrideRecordSchema.safeParse(record).success).toBe(true);
    expect(taskOverrideListResultSchema.safeParse({ tasks: [record] }).success).toBe(true);
    expect(taskOverrideShowResultSchema.safeParse({ task: record }).success).toBe(true);
    expect(taskOverrideShowResultSchema.safeParse({ task: null }).success).toBe(true);
    expect(taskOverrideSetResultSchema.safeParse({ task: record }).success).toBe(true);
    expect(taskOverrideUnsetResultSchema.safeParse({ removed: true }).success).toBe(true);
  });
});
