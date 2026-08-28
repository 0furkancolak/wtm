import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioPath = fileURLToPath(new URL('./idle-daemon.scenario.ts', import.meta.url));

describe('idle daemon release budget', () => {
  test('emits machine-readable CPU p95 and RSS target semantics', () => {
    const result = spawnSync('node', ['--import', 'tsx', scenarioPath], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      runtime: 'createProductionDaemon(SQLite, supervisor, Unix server, structural watcher)',
      samples: 20,
      cpuP95: expect.objectContaining({ unit: 'percent', target: 0.2, status: 'pass' }),
      rss: expect.objectContaining({ unit: 'MiB', target: 60, investigation: 80 }),
    });
  }, 30_000);
});
