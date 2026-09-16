import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfRuntimeInvocation, sourceRuntimeHooksUrl } from '../runtime-invocation';

const node = resolve('/opt/node/bin/node');

describe('selfRuntimeInvocation', () => {
  test('a standalone executable re-invokes itself with no entry script', () => {
    expect(selfRuntimeInvocation({ isSea: true, execPath: '/opt/wtm/wtm', entry: '/ignored/bin.ts' }))
      .toEqual({ executable: '/opt/wtm/wtm', prefixArgs: [] });
  });

  test('a built entry is re-invoked without any preload', () => {
    const entry = resolve('/opt/wtm/dist/cli/bin.js');
    expect(selfRuntimeInvocation({ isSea: false, execPath: node, entry }))
      .toEqual({ executable: node, prefixArgs: [entry] });
  });

  test('a TypeScript source entry is re-invoked with the in-thread source hooks, not the parent loader', () => {
    for (const name of ['bin.ts', 'bin.mts', 'bin.cts']) {
      const entry = resolve('/work/wtm/packages/cli/src', name);
      const invocation = selfRuntimeInvocation({ isSea: false, execPath: node, entry });
      expect(invocation).toEqual({ executable: node, prefixArgs: ['--import', sourceRuntimeHooksUrl(), entry] });
      expect(invocation.prefixArgs).not.toContain('tsx');
    }
  });

  test('a relative entry is made absolute, because the child starts in the task directory', () => {
    const invocation = selfRuntimeInvocation({ isSea: false, execPath: 'node', entry: 'packages/cli/src/bin.ts' });
    expect(invocation.executable).toBe(resolve('node'));
    expect(invocation.prefixArgs.at(-1)).toBe(resolve('packages/cli/src/bin.ts'));
  });

  test('a missing entry is refused', () => {
    expect(() => selfRuntimeInvocation({ isSea: false, execPath: node, entry: undefined }))
      .toThrow('WTM CLI entry path is unavailable');
  });

  test('the hooks URL names the shipped hooks module', async () => {
    expect(fileURLToPath(sourceRuntimeHooksUrl())).toBe(fileURLToPath(new URL('../source-runtime-hooks.ts', import.meta.url)));
    expect(await Bun.file(new URL(sourceRuntimeHooksUrl())).exists()).toBe(true);
  });
});
