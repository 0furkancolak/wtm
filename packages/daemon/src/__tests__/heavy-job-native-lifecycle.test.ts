import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario, scenarioTestTimeoutMs } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./heavy-job-native-lifecycle.scenario.ts', import.meta.url));
const cases = [
  { mode: 'cancel', state: 'CANCELLED', error: 'USER_CANCELLED' },
  { mode: 'timeout', state: 'TIMED_OUT', error: 'TIMEOUT' },
  { mode: 'restart-running', state: 'INTERRUPTED', error: 'DAEMON_INTERRUPTED' },
  { mode: 'completed-during-downtime', state: 'SUCCEEDED', error: null },
] as const;

for (const entry of cases) {
  test(`native heavy-job ${entry.mode} preserves evidence and releases the complete process tree`, () => {
    // No `timeoutMs`: `runScenario`'s own bound is there to end a hang, not to measure this
    // scenario, and a 30 s override made it a measurement -- of a POSIX number, on a leg where one
    // process observation is budgeted at 15 s. That is what "killed at 30000ms" was on win32.
    const result = runScenario('node', ['--import', 'tsx', scenario, entry.mode], {
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: entry.mode, state: entry.state, error: entry.error,
      groupAbsent: true, sourceValidity: 'UNCHANGED', launches: 1, terminalImmutable: true,
    });
  }, scenarioTestTimeoutMs());
}
