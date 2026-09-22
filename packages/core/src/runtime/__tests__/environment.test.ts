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

  test('passes an inherited value containing a literal brace through unchanged, rather than re-scanning it for templates', () => {
    // Regression: a two-pass implementation substituted {env.DATABASE_URL} first, then ran the
    // *whole result* back through template resolution -- so a legitimate env value containing
    // `{...}` (a connection string option, a JSON blob) was re-interpreted as an unresolved
    // template placeholder and threw, or worse, got silently replaced if its brace content
    // happened to spell a real template key.
    expect(resolveEnvironment({
      workspace: { URL: '{env.DATABASE_URL}' },
      context: {
        env: { DATABASE_URL: 'postgres://host/db?options={connect_timeout=10}' },
      },
    })).toEqual({ URL: 'postgres://host/db?options={connect_timeout=10}' });

    // The pathological case the two-pass bug could also produce: a brace-containing inherited
    // value whose content happens to name a real template variable gets silently substituted.
    expect(resolveEnvironment({
      workspace: { TITLE: '{env.RAW}' },
      context: {
        workspace: { root: '/projects/demo', name: 'demo' },
        slug: 'repo-main',
        env: { RAW: 'build for {slug}' },
      },
    })).toEqual({ TITLE: 'build for {slug}' });
  });
});
