import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentRuntimeInvocation } from '../runtime-invocation';
import { runScenario } from '../scenario-child';

// A cold TypeScript loader used to spawn a persistent esbuild service inside the anchor's
// detached process group. The anchor then waited for that service while the service waited
// for the anchor to exit. Observe real child creation in both Node and its loader worker;
// do not replace the anchor's identity or process-group readers to make this test pass.
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

const cases = [
  { name: 'anchor', argv: ['__wtm_internal_anchor', 'a'.repeat(64)], status: 1 },
  { name: 'adapter', argv: ['__wtm_internal_adapter', '2147483647', 'missing-adapter.mjs'], status: 1 },
  { name: 'endpoint probe', argv: ['__wtm_internal_endpoint_probe', '{'], status: 2 },
] as const;

for (const entry of cases) {
  test(`cold development ${entry.name} dispatch creates no compiler child`, () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-runtime-audit-'));
    const preload = join(root, 'audit.cjs');
    const trace = join(root, 'children.jsonl');
    writeFileSync(preload, childAudit);
    try {
      const invocation = developmentRuntimeInvocation();
      const result = runScenario(invocation.executable, [...invocation.prefixArgs, ...entry.argv], {
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
      expect(result.status, result.stderr).toBe(entry.status);
      const events = readFileSync(trace, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { kind: string; executable?: string });
      expect(events.filter((event) => event.kind === 'loaded').length).toBeGreaterThan(0);
      expect(events.filter((event) => event.kind === 'spawn')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
