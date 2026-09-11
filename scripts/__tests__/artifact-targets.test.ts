import { expect, test } from 'bun:test';
import { artifactTargetFor, publishedReleaseTargets } from '../artifact-targets';

test('local archive targets keep exact platform and architecture names', () => {
  expect(artifactTargetFor('darwin', 'arm64')).toEqual({
    platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm',
  });
  expect(artifactTargetFor('darwin', 'x64')).toEqual({
    platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm',
  });
  expect(artifactTargetFor('linux', 'x64')).toEqual({
    platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm',
  });
});

test('making Linux archives locally does not expand the published release target set', () => {
  expect(publishedReleaseTargets).toEqual([
    { platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm' },
    { platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm' },
  ]);
});

test('the target resolver refuses unsupported platforms, architectures and aliases', () => {
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'x64'], ['freebsd', 'x64'],
    ['darwin', 'ia32'], ['linux', 'x86_64'], ['', 'x64'], ['linux', '']] as const) {
    expect(() => artifactTargetFor(platform, arch)).toThrow();
  }
});
