import { beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

interface RankingScenario {
  exitCode: number;
  order: string[];
  ranks: number[];
  scores: number[];
  reasons: string[][];
  readiness: string[];
  mainWorktreeIncluded: boolean;
  humanExitCode: number;
  humanOrder: number[];
  unregisteredReasons: string[][];
}

const scenarioPath = fileURLToPath(new URL('./cleanup-ranking.scenario.ts', import.meta.url));
let scenario: RankingScenario;

// One spawn, many assertions: the fixture pushes, merges and reconciles a real repository, which
// is far too slow to repeat per test and produces one answer every test reads a different part of.
beforeAll(() => {
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  scenario = JSON.parse(result.stdout) as RankingScenario;
});

describe('analyze --cleanup-candidates ranking', () => {
  test('orders candidates by the safety tiers rather than by Git topology or path order', () => {
    expect(scenario.exitCode).toBe(0);
    expect(scenario.order).toEqual(['z-merged', 'linked feature', 'a-blocked']);
    expect(scenario.ranks).toEqual([1, 2, 3]);
  });

  test('every candidate carries a score and one reason per ranking input', () => {
    for (const score of scenario.scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
    for (const reason of scenario.reasons) expect(reason).toHaveLength(8);
    expect(scenario.reasons[0]).toContain('merged');
    expect(scenario.reasons[1]).toContain('not-merged');
  });

  test('score never disagrees with rank', () => {
    expect([...scenario.scores].sort((left, right) => right - left)).toEqual(scenario.scores);
  });

  test('the human rendering lists candidates in the same order as --json', () => {
    expect(scenario.humanExitCode).toBe(0);
    expect(scenario.humanOrder.every((position) => position >= 0)).toBe(true);
    expect([...scenario.humanOrder].sort((left, right) => left - right)).toEqual(scenario.humanOrder);
  });

  test('ranking still excludes the main worktree and still returns every linked one', () => {
    expect(scenario.order).toHaveLength(3);
    expect(scenario.mainWorktreeIncluded).toBe(false);
  });

  test('a candidate the safety analysis refuses to delete is ranked last, never filtered out', () => {
    // Dropping it would be a policy decision disguised as a sort, and would hide from the user
    // the one thing they need to see in order to fix it.
    expect(scenario.readiness[2]).not.toBe('SAFE');
    expect(scenario.reasons[2]).toContain(scenario.readiness[2]!);
  });

  test('an unregistered repository still ranks, naming the inputs nothing could answer', () => {
    expect(scenario.unregisteredReasons).toHaveLength(3);
    for (const reason of scenario.unregisteredReasons) {
      expect(reason).toContain('running-unknown');
      expect(reason).toContain('wtm-activity-unknown');
    }
  });
});
