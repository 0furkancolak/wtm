import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./heavy-job-completion-failure.scenario.ts', import.meta.url));
const cases = [
  { mode: 'both-throw', state: 'INTERRUPTED', error: 'COMPLETION_UNREADABLE' },
  { mode: 'final-throw', state: 'INTERRUPTED', error: 'COMPLETION_UNREADABLE' },
  { mode: 'recovered', state: 'SUCCEEDED', error: null },
  { mode: 'missing-after-failure', state: 'INTERRUPTED', error: 'COMPLETION_UNREADABLE' },
  { mode: 'missing-next-poll', state: 'INTERRUPTED', error: 'COMPLETION_UNREADABLE' },
  { mode: 'no-observed-exit', state: 'INTERRUPTED', error: 'COMPLETION_UNREADABLE' },
  { mode: 'cancel', state: 'CANCELLED', error: 'USER_CANCELLED' },
  { mode: 'timeout', state: 'TIMED_OUT', error: 'TIMEOUT' },
] as const;

for (const entry of cases) {
  test(`heavy-job completion validation controls terminal success: ${entry.mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, entry.mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...entry, nextSlotStarted: true });
  });
}
