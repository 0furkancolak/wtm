import { describe, expect, test } from 'bun:test';
import { externalDependencies, unloadable } from '../verify-install';

describe('externalDependencies', () => {
  test('keeps registry dependencies, drops workspace links, and sorts', () => {
    expect(externalDependencies({
      dependencies: {
        zod: '^4.1.0',
        '@wtm/protocol': 'workspace:*',
        commander: '14.0.2',
        '@wtm/core': 'workspace:*',
      },
    })).toEqual(['commander', 'zod']);
  });

  test('treats a manifest without dependencies as declaring none', () => {
    expect(externalDependencies({})).toEqual([]);
  });

  test('reads this repository as declaring the dependencies the suite loads', () => {
    const manifest = require('../../package.json') as { dependencies?: Record<string, string> };
    expect(externalDependencies(manifest)).toContain('zod');
  });
});

describe('unloadable', () => {
  test('reports nothing when every name imports', async () => {
    expect(await unloadable(['zod', 'commander'])).toEqual([]);
  });

  test('names the package that could not be loaded, with the reason', async () => {
    const failures = await unloadable(['zod', 'wtm-package-that-is-not-installed']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith('wtm-package-that-is-not-installed: ');
  });

  test('preserves the order it was given', async () => {
    const failures = await unloadable([
      'wtm-absent-one',
      'zod',
      'wtm-absent-two',
    ]);
    expect(failures.map((line) => line.split(':')[0])).toEqual(['wtm-absent-one', 'wtm-absent-two']);
  });
});
