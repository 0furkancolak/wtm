import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('shares one daemon slot across independent CLI processes and repositories', () => {
  // A previous warm loader cache hid an esbuild child in the managed anchor's process group.
  // The real native workflow must complete with cache disabled, at the same task deadline.
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./jobs-workflow.scenario.ts', import.meta.url))], {
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ detached: true, sharedSlot: true, idempotent: true, resultsVerified: true });
}, 30_000);

test('native queue memory admission holds a second repository despite two concurrency slots', () => {
  const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./jobs-workflow.scenario.ts', import.meta.url)), 'memory'], {
    env: { ...process.env, TSX_DISABLE_CACHE: '1' },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ detached: true, sharedSlot: true, idempotent: true, resultsVerified: true,
    memoryAdmission: true, queueEnvironment: true });
}, 30_000);
