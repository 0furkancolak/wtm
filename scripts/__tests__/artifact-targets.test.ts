import { expect, test } from 'bun:test';
import { artifactTargetFor, publishedReleaseTargets } from '../artifact-targets';

test('local archive targets keep exact platform and architecture names', () => {
  expect(artifactTargetFor('darwin', 'arm64')).toEqual({
    platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm',
  });
  expect(artifactTargetFor('darwin', 'x64')).toEqual({
    platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm',
  });
  expect(artifactTargetFor('linux', 'arm64')).toEqual({
    platform: 'linux', arch: 'arm64', archiveName: 'wtm-linux-arm64.tar.gz', executableName: 'wtm',
  });
  expect(artifactTargetFor('linux', 'x64')).toEqual({
    platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm',
  });
});

test('a tagged release publishes both macOS and both Linux archives', () => {
  // Item 29's Linux half. Publication is still narrower than the catalog -- Windows archives are
  // buildable by nothing here and published by nothing -- so the two lists stay separate.
  expect(publishedReleaseTargets).toEqual([
    { platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm' },
    { platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm' },
    { platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm' },
    { platform: 'linux', arch: 'arm64', archiveName: 'wtm-linux-arm64.tar.gz', executableName: 'wtm' },
  ]);
});

test('every published target is a local archive target the build can actually produce', () => {
  // The published list is a selection from the catalog, never a name invented beside it: a
  // published target `artifactTargetFor` cannot resolve is an archive no job knows how to build.
  for (const target of publishedReleaseTargets) {
    expect(artifactTargetFor(target.platform, target.arch)).toEqual(target);
  }
  expect(new Set(publishedReleaseTargets.map(({ archiveName }) => archiveName)).size)
    .toBe(publishedReleaseTargets.length);
});

test('the target resolver refuses unsupported platforms, architectures and aliases', () => {
  for (const [platform, arch] of [['linux', 'ia32'], ['win32', 'x64'], ['freebsd', 'x64'],
    ['darwin', 'ia32'], ['linux', 'x86_64'], ['', 'x64'], ['linux', '']] as const) {
    expect(() => artifactTargetFor(platform, arch)).toThrow();
  }
});
