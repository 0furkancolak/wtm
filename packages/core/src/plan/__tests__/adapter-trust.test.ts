import { afterEach, expect, test } from 'bun:test';
import { chmod, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeAdapter, type FakeAdapter } from '../../../../testkit/src/fake-adapter';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import { trustedFileTrustPolicy } from './file-trust-fixture';

const adapters: FakeAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.cleanup()));
});

test('keeps adapter ID, canonical path, SHA-256, and trusted time in the injected memory store', async () => {
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

test('refuses to trust a regular file that is not executable', async () => {
  const adapter = await createFakeAdapter({ type: 'response', response: {} });
  adapters.push(adapter);
  await chmod(adapter.executablePath, 0o600);

  await expect(trustRepositoryAdapter(createAdapterTrustStore(), {
    adapterId: 'fake', executablePath: adapter.executablePath,
  }, trustedFileTrustPolicy())).rejects.toThrow('External adapter executable is not executable.');
});

test('records the exact single-file declaration while execution-time resolution guards sibling modules', async () => {
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

test('rejects a non-exact Node 24 hashbang declaration', async () => {
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
