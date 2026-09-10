import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

const scenario = fileURLToPath(new URL('./endpoint-batch.scenario.ts', import.meta.url));
for (const name of ['allocation', 'budget', 'malformed', 'transport', 'native', 'legacy']) {
  test(`batched endpoint probing: ${name}`, () => {
    const result = runScenario('node', ['--import', 'tsx', scenario, name]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe('passed\n');
  });
}
