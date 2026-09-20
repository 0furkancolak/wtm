import { afterEach, expect, test } from 'bun:test';
import { chmod, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeAdapter, type FakeAdapter } from '../../../../testkit/src/fake-adapter';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import { trustedFileTrustPolicy } from './file-trust-fixture';
import { isWindowsTestHost } from '../../../../testkit/src/platform';

const adapters: FakeAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.cleanup()));
});

// These three (not the "refuses to trust" one below, which holds on every host) trust a real
// executable fixture and expect the trust to succeed. They stay POSIX-only, but no longer because
// of the execute bit: `assertSafeAdapterFile` now asks `FileTrustPolicy.isExecutable`, and these
// tests inject a policy that delegates to the POSIX answer, so the fixture's real execute bit is
// still what decides here. The reason the suite is POSIX-only is the one below it --
// `external-adapter.ts`'s `assertDescriptorExecutionSupported` refuses adapter execution on win32
// unconditionally in production -- which makes this a POSIX-execution-semantics test, the same
// way `posix.test.ts`'s uid comparison is.
test.skipIf(isWindowsTestHost)('keeps adapter ID, canonical path, SHA-256, and trusted time in the injected memory store', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);
  const alias = join(adapter.root, 'adapter-alias');
  await symlink(adapter.executablePath, alias);

  const store = createAdapterTrustStore();
  const record = await trustRepositoryAdapter(
    store, { adapterId: 'fake', executablePath: alias }, trustedFileTrustPolicy(),
  );

  expect(record).toMatchObject({
    adapterId: 'fake',
    canonicalPath: await realpath(adapter.executablePath),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(record.trustedAt).toSatisfy((value: string) => !Number.isNaN(Date.parse(value)));
  expect(store.list()).toEqual([record]);
});

/**
 * The executability answer comes from the injected policy on every host, so both directions are
 * stated by injecting one rather than by chmod-ing a file and trusting the host to agree.
 *
 * That is not indirection for its own sake. Before `FileTrustPolicy` grew `isExecutable`, this
 * call site read `stat.mode` itself, and the refusal below passed on Windows for a reason that
 * had nothing to do with the file: Node synthesises a Windows file's mode from the read-only
 * attribute, so no execute bit is ever set and *every* adapter was refused. A test that chmods a
 * file and expects a refusal cannot tell that apart from the behaviour it means to check.
 */
function policyReporting(executable: boolean) {
  const real = trustedFileTrustPolicy();
  return { ...real, isExecutable: () => Promise.resolve(executable) };
}

test('refuses to trust a file the policy reports as not executable', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);

  await expect(trustRepositoryAdapter(createAdapterTrustStore(), {
    adapterId: 'fake', executablePath: adapter.executablePath,
  }, policyReporting(false))).rejects.toThrow('External adapter executable is not executable.');
});

/**
 * The Windows condition, reproduced on a POSIX host: a file carrying no execute bit at all, and a
 * policy that answers the way the Windows one does because the filesystem there records none.
 * Trust must still be granted -- the format check is what proves this file is an adapter. Verified
 * red against the inline `stat.mode` test this replaced.
 */
test('trusts a file with no execute bit when the policy reports it executable', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);
  await chmod(adapter.executablePath, 0o600);

  const record = await trustRepositoryAdapter(createAdapterTrustStore(), {
    adapterId: 'fake', executablePath: adapter.executablePath,
  }, policyReporting(true));

  expect(record.adapterId).toBe('fake');
});

test.skipIf(isWindowsTestHost)('records the exact single-file declaration while execution-time resolution guards sibling modules', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);
  await writeFile(adapter.executablePath, [
    '#!/usr/bin/env node',
    '// wtm-adapter-v1: self-contained',
    "import { response } from './response.mjs';",
    'process.stdout.write(JSON.stringify(response));',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(adapter.executablePath, 0o700);

  await expect(trustRepositoryAdapter(createAdapterTrustStore(), {
    adapterId: 'fake', executablePath: adapter.executablePath,
  }, trustedFileTrustPolicy())).resolves.toMatchObject({ adapterId: 'fake' });
});

test.skipIf(isWindowsTestHost)('rejects a non-exact Node 24 hashbang declaration', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);
  await writeFile(adapter.executablePath, [
    '#!/usr/bin/env bun',
    '// wtm-adapter-v1: self-contained',
    'process.stdout.write("{}");',
    '',
  ].join('\n'), { mode: 0o700 });

  await expect(trustRepositoryAdapter(createAdapterTrustStore(), {
    adapterId: 'fake', executablePath: adapter.executablePath,
  }, trustedFileTrustPolicy())).rejects.toThrow('External adapter executable format is unsupported.');
});
