import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfRuntimeInvocation } from '@wtm/platform';
import { developmentNodeExecutable } from '../../../testkit/src/runtime-invocation';
import { runScenario } from '../../../testkit/src/scenario-child';

// The product's own re-invocation of a TypeScript source entry (todo 50c), with no testkit bundle.
// A private anchor is a detached process group that waits for the group to drain, so the loader
// must not leave a compiler service in it. Observe real child creation in the child itself.
const childAudit = String.raw`
const fs = require('node:fs');
const childProcess = require('node:child_process');
const path = require('node:path');
const record = (event) => fs.appendFileSync(process.env.WTM_TEST_CHILD_AUDIT, JSON.stringify(event) + '\n');
record({ kind: 'loaded' });
const spawn = childProcess.spawn;
childProcess.spawn = function(command, ...args) {
  record({ kind: 'spawn', executable: path.basename(command) });
  return spawn.call(this, command, ...args);
};
require('node:module').syncBuiltinESMExports();
`;

const entry = fileURLToPath(new URL('../bin.ts', import.meta.url));
const invocation = selfRuntimeInvocation({ isSea: false, execPath: developmentNodeExecutable(), entry });

const cases = [
  { name: 'anchor', argv: ['__wtm_internal_anchor', 'a'.repeat(64)], status: 1 },
  { name: 'adapter', argv: ['__wtm_internal_adapter', '2147483647', 'missing-adapter.mjs'], status: 1 },
  // A load failure would exit 1, so status 2 also proves the probe's module graph loaded.
  { name: 'endpoint probe', argv: ['__wtm_internal_endpoint_probe', '{'], status: 2 },
] as const;

for (const entryCase of cases) {
  test(`cold source ${entryCase.name} dispatch creates no compiler child`, () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-source-audit-'));
    const preload = join(root, 'audit.cjs');
    const trace = join(root, 'children.jsonl');
    writeFileSync(preload, childAudit);
    try {
      const result = runScenario(invocation.executable, [...invocation.prefixArgs, ...entryCase.argv], {
        input: '',
        env: {
          ...process.env,
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
          TSX_DISABLE_CACHE: '1',
          WTM_TEST_CHILD_AUDIT: trace,
          // Loading the real anchor with an invalid spec must fail before any task can start.
          WTM_ANCHOR_SPEC: '{',
        },
      });
      expect(result.status, result.stderr).toBe(entryCase.status);
      const events = readFileSync(trace, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { kind: string; executable?: string });
      expect(events.filter((event) => event.kind === 'loaded')).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'spawn')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// Node strips types only for erasable syntax. Every module a private mode imports has to load under
// the source hooks alone, or a source-launched daemon fails its jobs again.
test('every private runner module loads under the source hooks without tsx', () => {
  const modules = [
    '../internal.ts',
    '../pipe.ts',
    '../../../daemon/src/process-anchor.ts',
    '../../../core/src/plan/adapter-runner.ts',
    '../../../core/src/runtime/endpoint-probe.ts',
    '../../../core/src/runtime/endpoint-batch.ts',
  ].map((path) => new URL(path, import.meta.url).href);
  const script = `for (const url of ${JSON.stringify(modules)}) await import(url); console.log('loaded');`;
  const hooks = invocation.prefixArgs.slice(0, 2);
  const result = runScenario(invocation.executable, [...hooks, '--input-type=module', '-e', script], {
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('loaded');
  expect(result.stderr).toBe('');
});
