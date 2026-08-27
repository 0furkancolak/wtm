import { describe, expect, test } from 'bun:test';
import { resolveEnvironment } from '../environment';

describe('resolveEnvironment', () => {
  test('resolves references independently of declaration order and lets task values override workspace values', () => {
    expect(resolveEnvironment({
      workspace: {
        RESULT: '{env.PREFIX}/{env.SUFFIX}',
        PREFIX: '{env.HOME}/workspace',
        SUFFIX: 'global',
      },
      task: {
        SUFFIX: 'task',
      },
      context: {
        workspace: { root: '/projects/demo', name: 'demo' },
        env: { HOME: '/Users/developer' },
      },
    })).toEqual({
      RESULT: '/Users/developer/workspace/task',
      PREFIX: '/Users/developer/workspace',
      SUFFIX: 'task',
    });
  });

  test('fails deterministically when environment templates form a cycle', () => {
    expect(() => resolveEnvironment({
      workspace: { A: '{env.B}', B: '{env.A}' },
      context: { env: {} },
    })).toThrow('Circular environment template reference: A -> B -> A');
  });
});
