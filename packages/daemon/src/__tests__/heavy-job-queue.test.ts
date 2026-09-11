import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

describe('daemon heavy job queue', () => {
  for (const [mode, name] of [
    ['interrupted', 'upgrades provisional interrupted launch evidence to a confirmed timeout'],
    ['cancelled', 'preserves explicit cancellation when durable timeout evidence also exists'],
  ] as const) {
    test(name, () => {
      const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-timeout-evidence.scenario.ts', import.meta.url)), mode]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    });
  }
  test('accepts asynchronously, serializes work and keeps uncertain process trees in their slot', () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-queue.scenario.ts', import.meta.url))]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });
  test('preserves durable exit results across restart, rejects stale results and validates every IPC envelope', () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-recovery.scenario.ts', import.meta.url))]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });
});
