import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

describe('durable heavy job ownership', () => {
  test('serializes FIFO claims, idempotency, cancellation, retention, host scope and removal', () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-jobs.scenario.ts', import.meta.url))]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });
  test('uses cross-process SQLite transactions for concurrent admission, slot claims and removal', () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-jobs-concurrent.scenario.ts', import.meta.url))]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  }, 15_000);
});
