import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedReleaseTargets, requiredReleaseTargets } from './artifact-targets';

/** The full catalog. Anything outside it, in a SHA256SUMS the gate reads, is an unverified artifact. */
export const releaseArchiveNames: readonly string[] = publishedReleaseTargets.map(({ archiveName }) => archiveName);

/** What the whole-release gate refuses to publish without. See `requiredReleaseTargets`. */
export const requiredReleaseArchiveNames: readonly string[] = requiredReleaseTargets.map(({ archiveName }) => archiveName);

/**
 * The platform family whose executables Apple signs and notarizes. Signing, the notary service and
 * Gatekeeper are facts about Mach-O executables on macOS; every other published target has none of
 * them, and no equivalent of its own to satisfy.
 */
const applePlatform = 'darwin';

/**
 * What an archive outside {@link applePlatform} reports for signing and for notarization (todo item
 * 29, the Linux half). It is a status the workflow states rather than an absent value, for exactly
 * the reason `skipped` is one below: "this platform has no such notion" and "the evidence went
 * missing on the way to the gate" must not be the same input. It is accepted only for a selection
 * that contains no macOS archive — otherwise it would be the cheapest possible way to publish an
 * unsigned, unnotarized macOS binary through a stable tag.
 */
export const releaseNotApplicable = 'not-applicable';

/** Ad-hoc and unsigned executables are tolerable for prereleases only. */
export const releaseSigningStatuses = ['signed', 'adhoc', 'unsigned'] as const;

export type ReleaseSigningStatus = (typeof releaseSigningStatuses)[number];

/**
 * Notarization is binary: the Apple notary service accepted this build, or it was never asked.
 * `skipped` is what a build with no Apple credentials configured reports, and it is tolerable for
 * a prerelease only — the same bargain `adhoc` signing already strikes.
 */
export const releaseNotarizationStatuses = ['notarized', 'skipped'] as const;

export type ReleaseNotarizationStatus = (typeof releaseNotarizationStatuses)[number];

/**
 * The one archive a single build job produces. Keyed by platform *and* architecture: two published
 * targets share each architecture now, so an arch-only lookup would hand a Linux job the darwin
 * archive name and fail a build that did nothing wrong.
 */
export function releaseArchiveFor(platform: string, arch: string): string {
  const target = publishedReleaseTargets.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (target === undefined) {
    throw new Error(`No release archive is defined for ${platform}/${arch}`);
  }
  return target.archiveName;
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

/** The subset of `scripts/performance-report.ts`'s output the gate actually needs. */
export interface ReleasePerformanceReport {
  blockers: number;
  warnings: number;
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
  notarization?: string | undefined;
  /** One report per architecture this directory's job measured; the whole release for `publish`'s combined gate. */
  performance?: readonly ReleasePerformanceReport[] | undefined;
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

  // An explicit selection (a single leg's own gate) stays exactly as strict as before: precisely
  // that set, all of it present, nothing else listed. Omitting it (the whole-release gate) is the
  // one case `requiredReleaseTargets` softens: every required archive must still be present, but
  // an optional one (Windows, until todo item 9 lands) is verified fully when present and simply
  // skipped when it is not — its absence must not block macOS or Linux from shipping.
  const strictSelection = request.archives;
  if (strictSelection !== undefined
    && (!Array.isArray(strictSelection) || strictSelection.length === 0
      || new Set(strictSelection).size !== strictSelection.length
      || strictSelection.some((name) => !(releaseArchiveNames as readonly string[]).includes(name)))) {
    throw new Error('Release archive selection must be a non-empty, unique subset of the published release targets');
  }
  // The selection is settled before the signing evidence is judged, because which archives are
  // being gated is what decides whether Apple evidence applies to them at all.
  const required = strictSelection ?? requiredReleaseArchiveNames;
  verifySigning(release, request.signing, required);
  verifyNotarization(release, request.notarization, required);
  verifyPerformance(release, request.performance);

  const listed = parseChecksums(directory);
  const allowed = strictSelection ?? releaseArchiveNames;
  for (const name of listed.keys()) {
    if (!allowed.includes(name)) throw new Error(`SHA256SUMS lists unexpected entry ${name}`);
  }
  // Every required archive, plus whatever optional one actually got listed — an optional archive
  // that never built simply never appears here, rather than being demanded and refused.
  const toVerify = strictSelection ?? [...new Set([...required, ...listed.keys()])];
  const archives: ReleaseArchive[] = [];
  for (const name of toVerify) {
    const digest = listed.get(name);
    if (digest === undefined) throw new Error(`SHA256SUMS does not list ${name}`);
    const path = join(directory, name);
    if (!existsSync(path)) {
      throw new Error(`Release archive ${name} is listed in SHA256SUMS but missing from ${directory}`);
    }
    const contents = readFileSync(path);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (sha256 !== digest) {
      throw new Error(`${name} has SHA-256 ${sha256} but SHA256SUMS lists ${digest}`);
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

/** Whether this selection contains an archive Apple signing and notarization can describe at all. */
function containsAppleArchive(expected: readonly string[]): boolean {
  return publishedReleaseTargets.some(
    (target) => target.platform === applePlatform && expected.includes(target.archiveName),
  );
}

/**
 * The gate for a selection with no macOS archive in it. The status is required to say so outright:
 * an Apple status here was produced by some other build, which is the same wiring bug an absent
 * status is refused for, and claiming one must never be cheaper than admitting it does not apply.
 */
function verifyNotApplicable(kind: string, value: string | undefined, expected: readonly string[]): void {
  if (value === releaseNotApplicable) return;
  const found = value === undefined ? 'no status at all' : `"${value}"`;
  throw new Error(
    `Release archives ${expected.join(', ')} are not signed or notarized by Apple, so their `
    + `${kind} status must be "${releaseNotApplicable}", found ${found}`,
  );
}

/** The inverse: a macOS archive cannot opt out of the evidence that makes it runnable. */
function rejectNotApplicable(release: ReleaseVersion, kind: string, value: string | undefined): void {
  if (value !== releaseNotApplicable) return;
  throw new Error(
    `Release ${release.tag} publishes macOS archives, so "${releaseNotApplicable}" is not a `
    + `${kind} status it can have`,
  );
}

function verifySigning(release: ReleaseVersion, signing: string | undefined, expected: readonly string[]): void {
  if (!containsAppleArchive(expected)) {
    verifyNotApplicable('signing', signing, expected);
    return;
  }
  rejectNotApplicable(release, 'signing', signing);
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

/**
 * Increment G (todo.md items 5 and 36): a Developer ID signature alone does not get a downloaded
 * executable past Gatekeeper. On a fresh download the quarantine bit is set and the kernel
 * `SIGKILL`s at `exec`, before any WTM code runs — which is the whole reason item 36 had to ship
 * an `xattr -d com.apple.quarantine` workaround in the README. Only a notarization ticket clears
 * that, so a stable release publishing without one publishes something a first-time user cannot
 * run.
 *
 * A prerelease is exempt for exactly the reason `verifySigning` exempts it from requiring a
 * signature: it must stay buildable by a contributor who has no Apple credentials configured.
 * `skipped` is that state named explicitly rather than left as an absent value, so "nobody asked
 * the notary service" and "the evidence went missing on the way to the gate" cannot be confused
 * for one another — the second is a wiring bug and is refused outright.
 *
 * None of this describes an archive outside {@link applePlatform}: there is no ticket to fetch and
 * no Gatekeeper to clear, so such a selection reports {@link releaseNotApplicable} instead. What a
 * stable release still may not do is publish a *macOS* archive under that answer.
 */
function verifyNotarization(
  release: ReleaseVersion,
  notarization: string | undefined,
  expected: readonly string[],
): void {
  if (!containsAppleArchive(expected)) {
    verifyNotApplicable('notarization', notarization, expected);
    return;
  }
  rejectNotApplicable(release, 'notarization', notarization);
  const known = releaseNotarizationStatuses.join(' or ');
  if (notarization === undefined) {
    throw new Error(`Release verification requires a notarization status of ${known}`);
  }
  if (!(releaseNotarizationStatuses as readonly string[]).includes(notarization)) {
    throw new Error(`Unknown notarization status "${notarization}": expected ${known}`);
  }
  if (!release.prerelease && notarization !== 'notarized') {
    throw new Error(
      `Stable release ${release.tag} requires a notarized executable, found ${notarization}`,
    );
  }
}

/**
 * Item 4 (todo.md): docs called performance a "release gate" while `release.yml` never asked it
 * anything, so a real performance blocker never once stopped a release. This is the other half of
 * that fix -- the workflow wiring is what actually produces `WTM_RELEASE_PERFORMANCE`.
 *
 * A prerelease is exempt from a blocker the same way `verifySigning` exempts it from requiring a
 * signed executable: it exists to be tried, including for measuring whether a performance fix
 * worked, and refusing to publish it would remove the only vehicle for that. Only a stable
 * release -- the one `npm install <name>` actually hands out -- is refused.
 */
function verifyPerformance(release: ReleaseVersion, performance: readonly ReleasePerformanceReport[] | undefined): void {
  if (performance === undefined) {
    throw new Error('Release verification requires performance results: run bun run test:perf first');
  }
  if (!Array.isArray(performance)) {
    throw new Error('Release performance results must be an array with non-negative safe integers');
  }
  if (performance.length === 0) {
    throw new Error('Release verification requires performance results: run bun run test:perf first');
  }
  for (const report of performance) {
    if (!isPerformanceReport(report)) {
      throw new Error('Release performance counters must be non-negative safe integers');
    }
  }
  const blockers = performance.reduce((total, report) => total + BigInt(report.blockers), 0n);
  if (!release.prerelease && blockers > 0n) {
    throw new Error(
      `Stable release ${release.tag} has ${String(blockers)} performance blocker(s); see the uploaded performance artifacts for detail`,
    );
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

function readPerformanceResults(value: string | undefined): readonly ReleasePerformanceReport[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('WTM_RELEASE_PERFORMANCE must be a JSON array of {"blockers","warnings"} performance results with non-negative safe integers');
  }
  if (!Array.isArray(parsed) || parsed.some((report) => !isPerformanceReport(report))) {
    throw new Error('WTM_RELEASE_PERFORMANCE must be a JSON array of {"blockers","warnings"} performance results with non-negative safe integers');
  }
  return parsed as readonly ReleasePerformanceReport[];
}

function isPerformanceReport(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return isPerformanceCounter(report['blockers']) && isPerformanceCounter(report['warnings']);
}

function isPerformanceCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  const release = verifyReleaseTag(process.argv[2] ?? process.env['GITHUB_REF'] ?? '', version);
  // Both unset means the whole release, which is what the job collecting every leg gates. One set
  // without the other resolves no target and throws, rather than silently gating all four archives
  // in a job that built exactly one of them.
  const platform = process.env['WTM_RELEASE_PLATFORM']?.trim() ?? '';
  const arch = process.env['WTM_RELEASE_ARCH']?.trim() ?? '';
  const wholeRelease = platform === '' && arch === '';
  const manifest = verifyReleaseArtifacts({
    directory: join(root, 'dist/release'),
    release,
    packageVersion: version,
    smoke: readSmokeResults(process.env['WTM_RELEASE_SMOKE']),
    signing: process.env['WTM_RELEASE_SIGNING'],
    notarization: process.env['WTM_RELEASE_NOTARIZATION'],
    performance: readPerformanceResults(process.env['WTM_RELEASE_PERFORMANCE']),
    // Omitted rather than set to `releaseArchiveNames`: the whole-release gate now treats an
    // absent selection as "every required archive, plus whatever optional one is present" (see
    // `verifyReleaseArtifacts`), not "exactly this fixed list".
    ...(wholeRelease ? {} : { archives: [releaseArchiveFor(platform, arch)] }),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
