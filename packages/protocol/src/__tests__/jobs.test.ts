import { describe, expect, test } from 'bun:test';
import * as protocol from '../index';

describe('heavy-job wire contract', () => {
  test('registers strict bounded request schemas for every queue operation', () => {
    const schemas = (protocol as Record<string, any>).jobArgumentSchemas;
    expect(schemas).toBeDefined();
    expect(schemas['jobs.enqueue'].safeParse({ cwd: '/repo', taskName: 'test', idempotencyKey: 'retry-1' }).success).toBe(true);
    expect(schemas['jobs.enqueue'].safeParse({ cwd: '/repo', taskName: 'test' }).success).toBe(false);
    expect(schemas['jobs.enqueue'].safeParse({ cwd: '/repo', taskName: 'test', idempotencyKey: 'a', argv: ['secret'] }).success).toBe(false);
    expect(schemas['jobs.logs'].safeParse({ jobId: 'job-1', tail: 0 }).success).toBe(false);
    expect(schemas['jobs.logs'].safeParse({ jobId: 'job-1', tail: 1001 }).success).toBe(false);
    expect(schemas['jobs.list'].safeParse({ limit: 101 }).success).toBe(false);
    expect(schemas['jobs.cancel'].safeParse({ jobId: '../other' }).success).toBe(false);
  });

  test('acceptance does not assert completion and preserves explicit retry identity', () => {
    const schema = (protocol as Record<string, any>).enqueueAcceptanceSchema;
    expect(schema).toBeDefined();
    expect(schema.safeParse({ accepted: true, jobId: 'a', state: 'QUEUED', idempotencyKey: 'b', reused: false }).success).toBe(true);
    expect(schema.safeParse({ accepted: true, jobId: 'a', state: 'FAILED', idempotencyKey: 'b', reused: true }).success).toBe(true);
    expect(schema.safeParse({ accepted: true, jobId: 'a', state: 'QUEUED', reused: false }).success).toBe(false);
  });
});
