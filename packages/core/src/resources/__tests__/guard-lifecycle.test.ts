import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

for (const mode of ['dispose', 'one-shot', 'in-flight', 'production-gc'] as const) {
  test(`resource guard closes inode descriptors: ${mode}`, () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./guard-lifecycle.scenario.ts', import.meta.url)), mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    if (mode === 'production-gc') {
      expect(JSON.parse(result.stdout)).toMatchObject({ dryOk: true, applyOk: true, survivedDryRun: true, survivedApply: false });
    }
  });
}
