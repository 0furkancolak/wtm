import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A release publishes exactly these archives; anything else is an unverified artifact. */
export const releaseArchiveNames = ['wtm-darwin-arm64.tar.gz', 'wtm-darwin-x64.tar.gz'] as const;

/** Ad-hoc and unsigned executables are tolerable for prereleases only. */
export const releaseSigningStatuses = ['signed', 'adhoc', 'unsigned'] as const;

export type ReleaseSigningStatus = (typeof releaseSigningStatuses)[number];

/** The one archive a single-architecture build produces. */
export function releaseArchiveFor(arch: string): string {
  const name = `wtm-darwin-${arch}.tar.gz`;
  if (!(releaseArchiveNames as readonly string[]).includes(name)) {
    throw new Error(`No release archive is defined for architecture ${arch}`);
  }
  return name;
}

export interface ReleaseVersion {
  tag: string;
  version: string;
  prerelease: boolean;
}

export interface ReleaseSmokeCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ReleaseArchive {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  version: string;
  tag: string;
  archives: readonly ReleaseArchive[];
}

export interface ReleaseVerification {
  directory: string;
  release: ReleaseVersion;
  packageVersion: string;
  smoke?: readonly ReleaseSmokeCheck[] | undefined;
  signing?: string | undefined;
  /**
   * The archives this directory is expected to hold, defaulting to the whole release. A job that
   * builds one architecture can only produce one of them, and must gate exactly that one: asking
   * it for the other architecture's archive fails a build that did nothing wrong, and asking it
   * for nothing lets a half-built release through.
   */
  archives?: readonly string[] | undefined;
}

const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const checksumLine = /^(\S+) {2}(\S+)$/;
const sha256Digest = /^[0-9a-f]{64}$/;

export function verifyReleaseTag(ref: string, packageVersion: string): ReleaseVersion {
  const packaged = semver.exec(packageVersion);
  if (packaged === null) throw new Error(`Package version ${packageVersion} is not a valid SemVer version`);
  const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (!tag.startsWith('v')) {
    throw new Error(`Release tag ${tag} must start with "v": tag the release as v${packageVersion}`);
  }
  const version = tag.slice(1);
  const tagged = semver.exec(version);
  if (tagged === null) throw new Error(`Release tag ${tag} is not a valid SemVer version`);
  const prerelease = tagged[1] !== undefined;
  if (version === packageVersion) return { tag, version, prerelease };
  if (prerelease && packaged[1] === undefined) {
    throw new Error(`Prerelease tag ${tag} requires package version ${version}, found ${packageVersion}`);
  }
  if (!prerelease && packaged[1] !== undefined) {
    throw new Error(`Stable tag ${tag} requires package version ${version}, found prerelease ${packageVersion}`);
  }
  throw new Error(`Release tag ${tag} does not match package version ${packageVersion}`);
}

export function verifyReleaseArtifacts(request: ReleaseVerification): ReleaseManifest {
  const { directory, release, packageVersion } = request;
  if (release.version !== packageVersion) {
    throw new Error(`Released version ${release.version} does not match package version ${packageVersion}`);
  }
  verifySmoke(request.smoke);
  verifySigning(release, request.signing);

  const expected = request.archives ?? releaseArchiveNames;
  const listed = parseChecksums(directory);
  for (const name of listed.keys()) {
    if (!expected.includes(name)) throw new Error(`SHA256SUMS lists unexpected entry ${name}`);
  }
  const archives: ReleaseArchive[] = [];
  for (const name of expected) {
    const expected = listed.get(name);
    if (expected === undefined) throw new Error(`SHA256SUMS does not list ${name}`);
    const path = join(directory, name);
    if (!existsSync(path)) {
      throw new Error(`Release archive ${name} is listed in SHA256SUMS but missing from ${directory}`);
    }
    const contents = readFileSync(path);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (sha256 !== expected) {
      throw new Error(`${name} has SHA-256 ${sha256} but SHA256SUMS lists ${expected}`);
    }
    archives.push({ name, bytes: statSync(path).size, sha256 });
  }
  return buildReleaseManifest(release, archives);
}

export function buildReleaseManifest(
  release: ReleaseVersion,
  archives: readonly ReleaseArchive[],
): ReleaseManifest {
  return {
    version: release.version,
    tag: release.tag,
    archives: [...archives]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  };
}

/** Parses SHA256SUMS strictly: every line must be one unambiguous, unique digest entry. */
function parseChecksums(directory: string): Map<string, string> {
  const path = join(directory, 'SHA256SUMS');
  if (!existsSync(path)) throw new Error(`SHA256SUMS is missing from ${directory}`);
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries = new Map<string, string>();
  lines.forEach((line, index) => {
    const parsed = checksumLine.exec(line);
    if (parsed === null) throw new Error(`SHA256SUMS line ${index + 1} is malformed: "${line}"`);
    const [, sha256 = '', name = ''] = parsed;
    if (!sha256Digest.test(sha256)) {
      throw new Error(`SHA256SUMS line ${index + 1} has an unparsable SHA-256 digest: "${sha256}"`);
    }
    if (entries.has(name)) throw new Error(`SHA256SUMS lists ${name} more than once`);
    entries.set(name, sha256);
  });
  return entries;
}

function verifySmoke(smoke: readonly ReleaseSmokeCheck[] | undefined): void {
  if (smoke === undefined || smoke.length === 0) {
    throw new Error('Release verification requires executable smoke results: run bun run binary:verify first');
  }
  for (const check of smoke) {
    if (!check.passed) {
      throw new Error(`Executable smoke check ${check.name} failed: ${check.detail ?? 'no detail reported'}`);
    }
  }
}

function verifySigning(release: ReleaseVersion, signing: string | undefined): void {
  const known = releaseSigningStatuses.join(', ').replace(/, (?=[^,]*$)/, ', or ');
  if (signing === undefined) {
    throw new Error(`Release verification requires a signing status of ${known}`);
  }
  if (!(releaseSigningStatuses as readonly string[]).includes(signing)) {
    throw new Error(`Unknown signing status "${signing}": expected ${known}`);
  }
  if (!release.prerelease && signing !== 'signed') {
    throw new Error(`Stable release ${release.tag} requires a signed executable, found ${signing}`);
  }
}

function readSmokeResults(value: string | undefined): readonly ReleaseSmokeCheck[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('WTM_RELEASE_SMOKE must be a JSON array of {"name","passed"} smoke results');
  }
  if (!Array.isArray(parsed) || parsed.some((check) => !isSmokeCheck(check))) {
    throw new Error('WTM_RELEASE_SMOKE must be a JSON array of {"name","passed"} smoke results');
  }
  return parsed as readonly ReleaseSmokeCheck[];
}

function isSmokeCheck(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const check = value as Record<string, unknown>;
  return typeof check['name'] === 'string' && typeof check['passed'] === 'boolean';
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const release = verifyReleaseTag(process.argv[2] ?? process.env['GITHUB_REF'] ?? '', version);
  // Unset means the whole release, which is what the job that collects both architectures gates.
  const arch = process.env['WTM_RELEASE_ARCH']?.trim();
  const manifest = verifyReleaseArtifacts({
    directory: join(root, 'dist/release'),
    release,
    packageVersion: version,
    smoke: readSmokeResults(process.env['WTM_RELEASE_SMOKE']),
    signing: process.env['WTM_RELEASE_SIGNING'],
    archives: arch === undefined || arch === '' ? releaseArchiveNames : [releaseArchiveFor(arch)],
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
