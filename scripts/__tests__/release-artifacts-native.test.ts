import { expect, test } from 'bun:test';
import { runNativeArchiveScenario } from './release-artifacts-native.scenario';

// This checks GNU tar and an actual ELF on their host. Portable target/header cases live in
// release-artifacts.test.ts; this test does not substitute fixtures for native Windows/macOS proof.
test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
  'the Linux x64 archive extracts exact bytes, executable mode, notices and verified checksums',
  async () => {
    const result = await runNativeArchiveScenario();

    expect(result).toMatchObject({ platform: 'linux', arch: 'x64', inputExecutable: '/usr/bin/true',
      archiveName: 'wtm-linux-x64.tar.gz', mode: 0o755, smokeExitCode: 0 });
    expect(result.members).toEqual(['wtm', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md']);
    expect(result.archiveBytes).toBeGreaterThan(0);
    expect(result.archiveDigest).toMatch(/^[a-f0-9]{64}$/);
  },
);
