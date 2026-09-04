import { afterEach, describe, expect, test } from 'bun:test';
import { createFakeAdapter, type FakeAdapter } from '../../../../testkit/src/fake-adapter';
import { developmentRuntimeInvocation } from '../../../../testkit/src/runtime-invocation';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import { invokeExternalAdapter } from '../external-adapter';
import { trustedFileTrustPolicy } from './file-trust-fixture';

const adapters: FakeAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.cleanup()));
});

describe('guarded adapter child runtime invocation', () => {
  test('runs exact trusted bytes through the injected executable with no runtime on PATH', async () => {
    const response = {
      protocol: { major: 1 as const, minor: 0 },
      adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom' as const, provides: [] },
    };
    const adapter = await createFakeAdapter({ type: 'response', response });
    adapters.push(adapter);
    const trust = createAdapterTrustStore();
    await trustRepositoryAdapter(
      trust, { adapterId: 'fake', executablePath: adapter.executablePath }, trustedFileTrustPolicy(),
    );

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(await invokeExternalAdapter({
        adapterId: 'fake',
        executablePath: adapter.executablePath,
        repositoryRoot: adapter.root,
        operation: 'metadata',
        trust,
        runtimeInvocation: developmentRuntimeInvocation(),
        fileTrust: trustedFileTrustPolicy(),
      })).toEqual(response);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
