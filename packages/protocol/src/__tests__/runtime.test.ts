import { describe, expect, test } from 'bun:test';
import { readinessDurationMs, readinessObservationSchema, runtimeStartArgumentsSchema } from '../runtime';

describe('runtime readiness protocol', () => {
  test('keeps ordinary start compatible and only accepts an explicit bounded wait override', () => {
    const base = { cwd: '/repo', taskName: 'dev' };
    expect(runtimeStartArgumentsSchema.parse(base)).toEqual(base);
    expect(runtimeStartArgumentsSchema.parse({ ...base, wait: true, waitTimeoutMs: 300000 }).wait).toBe(true);
    for (const args of [{ waitTimeoutMs: 1000 }, { wait: false, waitTimeoutMs: 1000 }, { wait: true, waitTimeoutMs: 300001 }, { wait: true, waitTimeoutMs: 0 }, { wait: 'true' }, { wait: true, waitTimeoutMs: 1.5 }, { url: 'secret' }]) {
      expect(runtimeStartArgumentsSchema.safeParse({ ...base, ...args }).success).toBe(false);
    }
  });

  test('durations use the same finite bound in CLI and config', () => {
    expect(['1ms', '0.5s', '30s', '5m'].map(readinessDurationMs)).toEqual([1, 500, 30000, 300000]);
    for (const duration of ['0ms', '-1s', '6m', '1e3ms', '0.1ms', 'Infinity', '5m ']) expect(readinessDurationMs(duration)).toBeNull();
  });

  test('readiness evidence is bounded and never includes endpoint credentials', () => {
    const observation = { state: 'READY', probe: 'http', attempts: 2, elapsedMs: 123.4, observedAt: '2026-09-10T00:00:00.000Z' } as const;
    expect(readinessObservationSchema.parse(observation)).toEqual(observation);
    for (const change of [{ state: 'success' }, { attempts: -1 }, { elapsedMs: Infinity }, { url: 'http://secret/' }]) {
      expect(readinessObservationSchema.safeParse({ ...observation, ...change }).success).toBe(false);
    }
  });
});
