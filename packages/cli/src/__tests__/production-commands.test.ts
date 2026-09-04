import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./production-commands.scenario.ts', import.meta.url));

// The production CLI opens the real state store, so the scenario runs under Node, not Bun.
test('the production CLI wires persistent diagnostics and the foreground task runner', () => {
  const reportRoot = mkdtempSync(join(tmpdir(), 'wtm-production-report-'));
  const reportPath = join(reportRoot, 'report.json');

  try {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath, reportPath]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    // The task writes to the inherited stdout, which is what makes `run` a foreground command.
    expect(result.stdout).toContain('greeting');
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({
      registeredStatus: [0, true, 'production', true],
      uninitializedStatus: [2, false, 'WTM_NOT_INITIALIZED'],
      foregroundRun: [0, true, ['/bin/echo', 'greeting'], 0],
      multiRepoRootResolve: [2, false, 'WTM_WORKSPACE_NOT_FOUND', true, false, false, ['api', 'web']],
      multiRepoRootRunWithoutRepositories: [2, false, 'WTM_WORKSPACE_NOT_FOUND', true],
      // `--global` scopes a read for the diagnostic commands but chooses a destination here.
      scopedHelp: [
        'register in user WTM data instead of wtm.toml',
        'install into ~/.agents/skills instead of the current workspace',
      ],
    });
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }
}, 30_000);
