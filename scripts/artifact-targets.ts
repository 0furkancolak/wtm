/** Local archive support is independent from the targets enabled in the publication workflow. */
const localArtifactTargets = [
  { platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm' },
  { platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm' },
  { platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm' },
  { platform: 'linux', arch: 'arm64', archiveName: 'wtm-linux-arm64.tar.gz', executableName: 'wtm' },
] as const;

export type ArtifactTarget = (typeof localArtifactTargets)[number];

/**
 * What a tagged release actually carries (todo item 29). Every entry here is a selection from the
 * catalog above, never a name beside it: a published target the build cannot produce is an archive
 * no job knows how to make. Publication stays the narrower list — a Windows archive is neither
 * built nor published — and a target only joins it once a release job builds, smokes and gates it.
 */
export const publishedReleaseTargets = [
  localArtifactTargets[0],
  localArtifactTargets[1],
  localArtifactTargets[2],
  localArtifactTargets[3],
] as const;

export function artifactTargetFor(platform: string, arch: string): ArtifactTarget {
  const target = localArtifactTargets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (target === undefined) throw new Error(`Unsupported local archive target ${platform}/${arch}`);
  return target;
}
