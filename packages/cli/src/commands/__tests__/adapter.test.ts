import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarioTimeoutMs } from '../../../../testkit/src/scenario-child';

const scenarioPath = fileURLToPath(new URL('./adapter.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = spawnSync('node', ['--import', 'tsx', scenarioPath, name], { timeout: scenarioTimeoutMs, encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('trusts an adapter in the production SQLite state database and lists it', () => {
  expect(runScenario('sqlite-persistence')).toEqual({
    adapterId: 'fake',
    recordCount: 1,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    trustedAtIsIso: true,
  });
});

test('concurrent SQLite trust commands retain independent adapter records', () => {
  expect(runScenario('concurrent-trust')).toEqual({ adapterIds: ['first', 'second'] });
});

test('creates the missing private WTM state parent before opening SQLite', () => {
  expect(runScenario('creates-missing-private-parent')).toEqual({ ok: true, databaseCreated: true });
});

test('rejects insecure or symlinked WTM state parents before opening SQLite', () => {
  expect(runScenario('rejects-unsafe-private-parents')).toEqual({
    insecureMode: { ok: false, code: 'ADAPTER_NOT_TRUSTED' },
    symlinkParent: { ok: false, code: 'ADAPTER_NOT_TRUSTED' },
  });
});

test('rejects nested symlink parents and a database parent replaced after validation', () => {
  expect(runScenario('rejects-nested-symlink-and-parent-replacement')).toEqual({
    nestedSymlink: { ok: false, code: 'ADAPTER_NOT_TRUSTED' },
    replacedParent: { ok: false, code: 'ADAPTER_NOT_TRUSTED' },
  });
});
