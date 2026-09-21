import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { runScenario } from '../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./task-override-resolution.scenario.ts', import.meta.url));

describe('DB task overrides in worktree runtime resolution', () => {
  test('a wtm task set record wins over the file task, adds a task the file never declared, and provenance says db', () => {
    const result = runScenario('node', ['--import', 'tsx', scenarioPath], { timeoutMs: 30_000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');

    expect(JSON.parse(result.stdout)).toEqual({
      beforeArgv: ['node', 'server.js'],
      beforeBackground: true,
      beforeProvenance: expect.stringContaining('wtm.toml'),
      overriddenArgv: ['node', 'server.js', '--override'],
      overriddenBackground: false,
      overriddenProvenance: 'db',
      overriddenBackgroundProvenance: undefined,
      dbOnlyArgv: ['echo db-only'],
      buildStillFromFile: ['npm run build'],
      afterDeleteArgv: ['node', 'server.js'],
      afterDeleteProvenance: expect.stringContaining('wtm.toml'),
    });
  }, 30_000);
});
