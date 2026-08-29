import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createFakeAdapter, type FakeAdapter } from '../../../../testkit/src/fake-adapter';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import { invokeExternalAdapter } from '../external-adapter';
import { fileURLToPath } from 'node:url';

const adapters: FakeAdapter[] = [];
const cliEntry = fileURLToPath(new URL('../../../../cli/src/bin.ts', import.meta.url));
const nodeExecutable = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();

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
    await trustRepositoryAdapter(trust, { adapterId: 'fake', executablePath: adapter.executablePath });

    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(invokeExternalAdapter({
        adapterId: 'fake',
        executablePath: adapter.executablePath,
        repositoryRoot: adapter.root,
        operation: 'metadata',
        trust,
        runtimeInvocation: {
          executable: nodeExecutable,
          prefixArgs: ['--import', import.meta.resolve('tsx'), cliEntry],
        },
      })).resolves.toEqual(response);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
