/** Local archive support is independent from the targets enabled in the publication workflow. */
const localArtifactTargets = [
  { platform: 'darwin', arch: 'arm64', archiveName: 'wtm-darwin-arm64.tar.gz', executableName: 'wtm' },
  { platform: 'darwin', arch: 'x64', archiveName: 'wtm-darwin-x64.tar.gz', executableName: 'wtm' },
  { platform: 'linux', arch: 'x64', archiveName: 'wtm-linux-x64.tar.gz', executableName: 'wtm' },
] as const;

export type ArtifactTarget = (typeof localArtifactTargets)[number];

/** Enabling local Linux packaging does not add a target to a tagged release. */
export const publishedReleaseTargets = [localArtifactTargets[0], localArtifactTargets[1]] as const;

export function artifactTargetFor(platform: string, arch: string): ArtifactTarget {
  const target = localArtifactTargets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (target === undefined) throw new Error(`Unsupported local archive target ${platform}/${arch}`);
  return target;
}
