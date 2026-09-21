import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createAdapterTrustStore } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import { createFakeAdapter } from '../../../../testkit/src/fake-adapter';
import { runScenario as runScenarioChild } from '../../../../testkit/src/scenario-child';
import { runAdapterCommand } from '../adapter';

const scenarioPath = fileURLToPath(new URL('./adapter.scenario.ts', import.meta.url));

function runScenario(name: string): Record<string, unknown> {
  const result = runScenarioChild('node', ['--import', 'tsx', scenarioPath, name]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
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

/**
 * The selected policy has to reach the adapter executable's own safety checks, not only the
 * private directory above the database.
 *
 * Written so a POSIX run can fail on the win32 defect: there, the policy that never arrived was
 * the ACL one and the fallback that answered instead refused everything, which took
 * `wtm adapter trust` down even with its trust store injected and no private directory in play.
 * Here the contrast runs the other way, because a policy that only ever agreed with the default
 * would prove nothing: an injected policy that refuses ownership must be the one consulted. The
 * two cases pin both halves -- the command is not simply refusing for some unrelated reason.
 */
const refusingPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser: async () => false,
  isWritableOnlyByOwner: async () => true,
  isNotSharedByHardLink: () => true,
  currentIdentityAvailable: () => true,
  // True, so the refusal below is attributable to ownership alone and not to two reasons at once.
  isExecutable: async () => true,
};

test('trusts an adapter executable through the injected policy rather than core\'s POSIX fallback', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  try {
    const accepted = await runAdapterCommand({
      action: 'trust',
      adapterId: 'fake',
      executablePath: adapter.executablePath,
      databasePath: 'unused-because-the-store-is-injected',
      trust: createAdapterTrustStore(),
      // The host's, like `adapter.scenario.ts` and both of `main.ts`'s call sites. Injecting
      // nothing here left this half falling through to core's POSIX fallback, which is the very
      // thing the test's name says it is avoiding -- and on win32 that fallback refuses, so the
      // accepting case could not pass there however the command behaved.
      fileTrust: selectPlatformRuntime().fileTrust,
    });
    // The envelope's own errors as the failure message: a bare `toBe(true)` here reported that
    // the command refused without ever saying why, which cost two win32 rounds to a refusal the
    // log could have named the first time. Every refusal this command can reach carries a
    // message, so there is nothing to guess at once the assertion prints them.
    expect(accepted.ok, JSON.stringify(accepted.errors)).toBe(true);

    const refused = await runAdapterCommand({
      action: 'trust',
      adapterId: 'fake',
      executablePath: adapter.executablePath,
      databasePath: 'unused-because-the-store-is-injected',
      trust: createAdapterTrustStore(),
      fileTrust: refusingPolicy,
    });
    expect(refused.ok).toBe(false);
    expect(refused.errors[0]?.code).toBe('ADAPTER_NOT_TRUSTED');
  } finally {
    await adapter.cleanup();
  }
});
