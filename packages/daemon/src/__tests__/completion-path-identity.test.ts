import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

for (const [mode, name] of [
  ['existing-symlink', 'rejects a completion symlink when O_NOFOLLOW does not prevent following it'],
  ['dangling-symlink', 'distinguishes a dangling completion symlink from a missing marker'],
  ['transient-symlink', 'rejects a foreign descriptor even when the original marker path is restored'],
  ['replaced-after-open', 'rejects a completion marker replaced after its descriptor was opened'],
  ['missing-and-valid', 'preserves absent-marker semantics and reads valid completion evidence'],
  ['rotation', 'preserves cursor progression through legitimate log rotation'],
  ['generation-initial', 'retries atomic generation replacement during the initial marker open'],
  ['generation-final', 'retries atomic generation replacement during the final marker open without duplicate bytes'],
  ['generation-churn', 'refuses persistent marker identity churn at the existing three-attempt bound'],
  ['segment-identity', 'retries segment identity changes while an in-progress generation marker stays unchanged'],
] as const) {
  test(name, () => {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./completion-path-identity.scenario.ts', import.meta.url)), mode]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });
}
