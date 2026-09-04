import { readdir } from 'node:fs/promises';
import { createFakeAdapter } from '../../../../testkit/src/fake-adapter';
import { developmentRuntimeInvocation } from '../../../../testkit/src/runtime-invocation';
import { createAdapterTrustStore, trustRepositoryAdapter } from '../adapter-trust';
import { invokeExternalAdapter } from '../external-adapter';
import { trustedFileTrustPolicy } from './file-trust-fixture';

const response = {
  protocol: { major: 1, minor: 0 },
  adapter: { id: 'fake', name: 'Fake', version: '1.0.0', kind: 'custom', provides: [] },
};
const adapter = await createFakeAdapter({ type: 'response', response });
const trust = createAdapterTrustStore();
try {
  await trustRepositoryAdapter(
    trust, { adapterId: 'fake', executablePath: adapter.executablePath }, trustedFileTrustPolicy(),
  );
  let afterVerificationRan = false;
  let snapshotArtifactSeen = false;
  const actual = await invokeExternalAdapter({
    adapterId: 'fake', executablePath: adapter.executablePath, repositoryRoot: adapter.root,
    operation: 'metadata', trust,
    hooks: {
      async afterVerification() {
        afterVerificationRan = true;
        snapshotArtifactSeen ||= (await readdir(process.env.TMPDIR!)).some((entry) =>
          entry.startsWith('wtm-adapter-snapshot-') || entry.startsWith('wtm-adapter-execution-'));
      },
    },
    runtimeInvocation: developmentRuntimeInvocation(),
    fileTrust: trustedFileTrustPolicy(),
  });
  process.stdout.write(`${JSON.stringify({ afterVerificationRan, snapshotArtifactSeen, response: actual })}\n`);
} finally {
  await adapter.cleanup();
}
