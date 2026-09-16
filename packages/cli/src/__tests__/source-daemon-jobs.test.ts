import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedHomeEnvironment } from '../../../testkit/src/isolated-home';
import { shortTmpRoot } from '../../../testkit/src/platform';
import { runScenario } from '../../../testkit/src/scenario-child';

// todo 50c: a daemon launched from source with `node --import tsx` used to fail every queued job
// with RUNTIME_START_FAILED, because its re-invoked anchor could not load the `.ts` entry.
// No runtime invocation is injected here; the tsx cache is disabled so the loader runs cold.
test('a daemon started from source with node --import tsx runs a queued job to success', () => {
  const home = mkdtempSync(join(shortTmpRoot(), 'wtm-src-'));
  try {
    const result = runScenario('node', ['--import', 'tsx', fileURLToPath(new URL('./source-daemon-jobs.scenario.ts', import.meta.url))], {
      env: { ...process.env, ...isolatedHomeEnvironment(home), TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sourceDaemon: true, jobSucceeded: true, logged: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
