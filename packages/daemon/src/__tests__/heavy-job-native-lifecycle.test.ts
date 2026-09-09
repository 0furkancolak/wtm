import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./heavy-job-native-lifecycle.scenario.ts', import.meta.url));
const cases = [
  { mode: 'cancel', state: 'CANCELLED', error: 'USER_CANCELLED' },
  { mode: 'timeout', state: 'TIMED_OUT', error: 'TIMEOUT' },
  { mode: 'restart-running', state: 'INTERRUPTED', error: 'DAEMON_INTERRUPTED' },
  { mode: 'completed-during-downtime', state: 'SUCCEEDED', error: null },
] as const;

for (const entry of cases) {
  test(`native heavy-job ${entry.mode} preserves evidence and releases the complete process tree`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, entry.mode], {
      timeoutMs: 30_000,
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: entry.mode, state: entry.state, error: entry.error,
      groupAbsent: true, sourceValidity: 'UNCHANGED', launches: 1, terminalImmutable: true,
    });
  }, 35_000);
}
