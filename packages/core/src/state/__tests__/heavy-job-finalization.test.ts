import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../../testkit/src/scenario-child';

describe('heavy job finalization arbitration', () => {
  for (const [mode, name] of [
    ['cancellation', 'preserves cancellation accepted before the final transaction'],
    ['timeout', 'preserves confirmed timeout over stale interruption and keeps exit evidence'],
    ['cancelled-timeout', 'preserves explicit cancellation over timeout evidence'],
    ['interruption', 'preserves durable interruption diagnostics over stale success'],
    ['specific-timeout', 'keeps specific timeout diagnostics when the state already matches'],
    ['queued-cancellation', 'does not rewrite a cancelled queued job during late finish'],
    ['terminal-immutable', 'does not rewrite a terminal result after late cancellation or completion'],
  ] as const) {
    test(name, () => {
      const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./heavy-job-finalization.scenario.ts', import.meta.url)), mode]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    });
  }
});
