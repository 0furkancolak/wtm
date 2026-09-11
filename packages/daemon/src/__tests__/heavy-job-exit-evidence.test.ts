import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

for (const mode of ['task-signal', 'anchor-signal', 'deadline-refusal', 'cancel-stop', 'timeout-stop', 'confirm-stop']) {
  test(`preserves the complete durable task exit tuple: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-exit-evidence.scenario.ts', import.meta.url)), mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
}
