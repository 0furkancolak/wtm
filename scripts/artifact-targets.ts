/** Local archive support is independent from the targets enabled in the publication workflow. */
const localArtifactTargets = [
  { platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm' },
  { platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm' },
  { platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm' },
  { platform: 'linux', arch: 'arm64', archiveName: 'wtm-linux-arm64.tar.gz', executableName: 'wtm' },
  { platform: 'win32', arch: 'x64', archiveName: 'wtm-windows-x64.zip', executableName: 'wtm.exe' },
] as const;

export type ArtifactTarget = (typeof localArtifactTargets)[number];

/**
 * What a tagged release actually carries (todo item 29). Every entry here is a selection from the
 * catalog above, never a name beside it: a published target the build cannot produce is an archive
 * no job knows how to make. A target only joins this list once a release job builds, smokes and
 * gates it — W6-1 (29b) is that job for the Windows x64 entry.
 */
export const publishedReleaseTargets = [
  localArtifactTargets[0],
  localArtifactTargets[1],
  localArtifactTargets[2],
  localArtifactTargets[3],
  localArtifactTargets[4],
] as const;

/**
 * The subset of {@link publishedReleaseTargets} a release cannot ship without. CLAUDE.md states
 * win32 CI as informational until todo item 9 lands, and item 9 has not landed: a real tag whose
 * Windows leg hits one of that item's still-open native failures must still let macOS and Linux
 * ship, exactly as an informational win32 CI leg does not block an ordinary merge. Windows moves
 * into this list the day item 9 does; until then a present, correct Windows archive is still
 * fully verified (see `verify-release.ts`), it is simply not required for the gate to pass.
 */
export const requiredReleaseTargets = publishedReleaseTargets.filter((target) => target.platform !== 'win32');

export function artifactTargetFor(platform: string, arch: string): ArtifactTarget {
  const target = localArtifactTargets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (target === undefined) throw new Error(`Unsupported local archive target ${platform}/${arch}`);
  return target;
}
