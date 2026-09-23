import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./analyze-nested-worktree.scenario.ts', import.meta.url));

interface ScenarioOutput {
  exitCode: number;
  ok: boolean;
  resolvedPath: string | null;
  resolvedIsMain: boolean | null;
  expectedPath: string;
}

describe('wtm analyze with no selector, from inside a nested linked worktree', () => {
  test('resolves the linked worktree the cwd is actually in, not the main worktree that contains it', () => {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath], { timeoutMs: 20_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as ScenarioOutput;
    expect(output.exitCode).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.resolvedPath).toBe(output.expectedPath);
    expect(output.resolvedIsMain).toBe(false);
  }, 20_000);
});
