import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./proxy-dev-overlay-checklist.scenario.ts', import.meta.url));

interface ScenarioOutput {
  status: number;
  containsBackendHtml: boolean;
  containsChecklistText: boolean;
  containsChecklistCheckbox: boolean;
}

/**
 * A real `createProductionDaemon` composition, proxy and dev-overlay enabled through its actual
 * global-config path — not the hand-built store doubles `dev-overlay.test.ts` and
 * `proxy-dev-overlay.test.ts` use for the rendering logic itself. Those two are exhaustive about
 * `renderDevOverlayFragment`/`gatherDevOverlayData`, but neither one can catch a break in the
 * wiring between `runtime-factory.ts` and that logic, because they construct the `DevOverlaySource`
 * by hand. This is the one test that goes through the real object `createProductionDaemon` builds.
 */
describe('production daemon: dev overlay checklist reaches a real proxied response', () => {
  test('a checklist item set on the worktree renders as a checkbox in the proxied HTML', () => {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath], { timeoutMs: 20_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as ScenarioOutput;
    expect(output.status).toBe(200);
    expect(output.containsBackendHtml).toBe(true);
    expect(output.containsChecklistText).toBe(true);
    expect(output.containsChecklistCheckbox).toBe(true);
  }, 20_000);
});
