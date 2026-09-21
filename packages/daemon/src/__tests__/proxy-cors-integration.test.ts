import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { slugifyBranchLabel } from '@wtm/core';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./proxy-cors-integration.scenario.ts', import.meta.url));

/**
 * The scenario's fixture worktree is on `feature/existing`, alone in its collision group. The
 * slug is derived from `WorktreeRecord.branch` as the state store actually holds it — the full
 * ref `git worktree list --porcelain` reports (`worktree-parser.ts` does not strip
 * `refs/heads/`, and nothing downstream of it does either) — not the short name `docs/07`'s own
 * prose example uses. See this file's own note below on that gap.
 */
const slug = slugifyBranchLabel('refs/heads/feature/existing');

interface ScenarioOutput {
  origins: string[];
  corsOrigins: string;
  webPort: number;
  apiPort: number;
}

function runProxyCorsScenario(mode: string): ScenarioOutput {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath, mode], { timeoutMs: 30_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as ScenarioOutput;
}

describe('proxy hostname origins joining the CORS allowlist (W10-1)', () => {
  /**
   * `[proxy]` unset (no global config file at all — the same ENOENT path every daemon before
   * this unit took) must produce byte-identical origins to before this unit existed: no proxy
   * hostname, and no third origin string of any kind.
   */
  test('proxy disabled: CORS origins are exactly the dynamic-port origins, unchanged', () => {
    const output = runProxyCorsScenario('disabled');
    expect(output.origins).toEqual([`http://localhost:${output.webPort}`]);
    expect(output.corsOrigins).toBe(`http://localhost:${output.webPort}`);
  }, 30_000);

  /**
   * `[proxy] enabled = true` with an explicit port: the `web` endpoint (no `origin = false`)
   * gains a second, proxy-hostname origin using that configured port, alongside its existing
   * dynamic-port one. `api` opted out of a browser origin (`origin = false`) and must gain
   * neither the dynamic-port nor the proxy-hostname origin — the opt-out sanity check.
   */
  test('proxy enabled: the proxy hostname joins the dynamic-port origin, opted-out endpoints stay out', () => {
    const output = runProxyCorsScenario('enabled');
    const dynamic = `http://localhost:${output.webPort}`;
    const proxied = `http://web.${slug}.wtm.localhost:34567`;
    expect(output.origins).toEqual([dynamic]);
    expect(output.corsOrigins.split(',').sort()).toEqual([dynamic, proxied].sort());
    // No trace of the opted-out endpoint's port, under either origin form.
    expect(output.corsOrigins).not.toContain(String(output.apiPort));
    expect(output.corsOrigins).not.toContain('.api.');
    expect(output.corsOrigins.includes(`api.${slug}.wtm.localhost`)).toBe(false);
  }, 30_000);

  /** `[proxy] enabled = true` with no `port`: the proxy hostname uses `defaultProxyPort` (19999). */
  test('proxy enabled without an explicit port falls back to the default proxy port', () => {
    const output = runProxyCorsScenario('enabled-default-port');
    const dynamic = `http://localhost:${output.webPort}`;
    const proxied = `http://web.${slug}.wtm.localhost:19999`;
    expect(output.corsOrigins.split(',').sort()).toEqual([dynamic, proxied].sort());
  }, 30_000);
});
