import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../packages/testkit/src/scenario-child';
import {
  buildReleaseManifest,
  releaseArchiveFor,
  releaseArchiveNames,
  releaseNotApplicable,
  verifyReleaseArtifacts,
  verifyReleaseTag,
  type ReleasePerformanceReport,
  type ReleaseSmokeCheck,
  type ReleaseVerification,
} from '../verify-release';

const payloads: Readonly<Record<string, string>> = {
  'wtm-darwin-arm64.tar.gz': 'arm64 archive payload',
  'wtm-darwin-x64.tar.gz': 'x64 archive payload',
  'wtm-linux-arm64.tar.gz': 'linux arm64 archive payload',
  'wtm-linux-x64.tar.gz': 'linux x64 archive payload',
  'wtm-windows-x64.zip': 'windows x64 archive payload',
};
/** The one archive a single Linux leg builds, gated on its own the way a single darwin leg is. */
const linuxArm64 = 'wtm-linux-arm64.tar.gz';
const smoke: readonly ReleaseSmokeCheck[] = [{ name: 'wtm --version', passed: true }];
const performance: readonly ReleasePerformanceReport[] = [{ blockers: 0, warnings: 0 }];
const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) rmSync(temporaries.pop() as string, { recursive: true, force: true });
});

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function checksums(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries).map(([name, contents]) => `${digest(contents)}  ${name}\n`).join('');
}

function stage(files: Readonly<Record<string, string>> = payloads, document: string | null = null): string {
  const directory = mkdtempSync(join(tmpdir(), 'wtm-verify-release-'));
  temporaries.push(directory);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents);
  if (document !== null) writeFileSync(join(directory, 'SHA256SUMS'), document);
  else writeFileSync(join(directory, 'SHA256SUMS'), checksums(files));
  return directory;
}

function request(directory: string, overrides: Partial<ReleaseVerification> = {}): ReleaseVerification {
  return {
    directory,
    release: { tag: 'v1.2.3', version: '1.2.3', prerelease: false },
    packageVersion: '1.2.3',
    smoke,
    signing: 'signed',
    notarization: 'notarized',
    performance,
    ...overrides,
  };
}

describe('release tag gate', () => {
  test('accepts a stable tag that equals the package version', () => {
    expect(verifyReleaseTag('v1.2.3', '1.2.3')).toEqual({ tag: 'v1.2.3', version: '1.2.3', prerelease: false });
  });

  test('accepts a fully qualified tag ref', () => {
    expect(verifyReleaseTag('refs/tags/v1.2.3', '1.2.3')).toEqual({
      tag: 'v1.2.3',
      version: '1.2.3',
      prerelease: false,
    });
  });

  test('accepts a prerelease tag that equals the package version exactly', () => {
    expect(verifyReleaseTag('v1.2.3-rc.1', '1.2.3-rc.1')).toEqual({
      tag: 'v1.2.3-rc.1',
      version: '1.2.3-rc.1',
      prerelease: true,
    });
  });

  test('rejects a tag without the leading v', () => {
    expect(() => verifyReleaseTag('1.2.3', '1.2.3')).toThrow(
      'Release tag 1.2.3 must start with "v": tag the release as v1.2.3',
    );
  });

  test('rejects a prerelease tag against a stable package version', () => {
    expect(() => verifyReleaseTag('v1.2.3-rc.1', '1.2.3')).toThrow(
      'Prerelease tag v1.2.3-rc.1 requires package version 1.2.3-rc.1, found 1.2.3',
    );
  });

  test('rejects a stable tag against a prerelease package version', () => {
    expect(() => verifyReleaseTag('v1.2.3', '1.2.3-rc.1')).toThrow(
      'Stable tag v1.2.3 requires package version 1.2.3, found prerelease 1.2.3-rc.1',
    );
  });

  test('rejects a malformed SemVer tag', () => {
    expect(() => verifyReleaseTag('v1.2', '1.2.3')).toThrow('Release tag v1.2 is not a valid SemVer version');
  });

  test('rejects a malformed package version', () => {
    expect(() => verifyReleaseTag('v1.2.3', '1.2')).toThrow('Package version 1.2 is not a valid SemVer version');
  });

  test('rejects a tag whose version is not the package version', () => {
    expect(() => verifyReleaseTag('v1.2.4', '1.2.3')).toThrow(
      'Release tag v1.2.4 does not match package version 1.2.3',
    );
  });

  test('rejects two different prerelease versions', () => {
    expect(() => verifyReleaseTag('v1.2.3-rc.2', '1.2.3-rc.1')).toThrow(
      'Release tag v1.2.3-rc.2 does not match package version 1.2.3-rc.1',
    );
  });
});

describe('release artifact gate', () => {
  test('accepts a staged release and returns an ordered manifest', () => {
    const directory = stage();

    expect(verifyReleaseArtifacts(request(directory))).toEqual({
      version: '1.2.3',
      tag: 'v1.2.3',
      archives: Object.keys(payloads)
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({
          name,
          bytes: Buffer.byteLength(payloads[name] as string),
          sha256: digest(payloads[name] as string),
        })),
    });
  });

  test('publishes both macOS archives, both Linux archives, and the Windows archive', () => {
    // Item 29 / W6-1: a tagged release carries these as real assets, not only as something
    // `bun run release:artifacts` can build on a contributor's own machine.
    expect(releaseArchiveNames).toEqual([
      'wtm-darwin-arm64.tar.gz',
      'wtm-darwin-x64.tar.gz',
      'wtm-linux-x64.tar.gz',
      'wtm-linux-arm64.tar.gz',
      'wtm-windows-x64.zip',
    ]);
  });

  test('names one archive per published platform and architecture, never by architecture alone', () => {
    // Two published targets share each architecture now, so an arch-only lookup would hand a Linux
    // leg the darwin archive name and fail a build that did nothing wrong.
    expect(releaseArchiveFor('darwin', 'arm64')).toBe('wtm-darwin-arm64.tar.gz');
    expect(releaseArchiveFor('linux', 'arm64')).toBe(linuxArm64);
    expect(releaseArchiveFor('darwin', 'x64')).toBe('wtm-darwin-x64.tar.gz');
    expect(releaseArchiveFor('linux', 'x64')).toBe('wtm-linux-x64.tar.gz');
    expect(releaseArchiveFor('win32', 'x64')).toBe('wtm-windows-x64.zip');
    for (const [platform, arch] of [['linux', 'ia32'], ['win32', 'arm64'], ['', 'arm64'], ['linux', '']] as const) {
      expect(() => releaseArchiveFor(platform, arch)).toThrow('No release archive is defined for');
    }
  });

  test('rejects a staged release without SHA256SUMS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wtm-verify-release-'));
    temporaries.push(directory);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow('SHA256SUMS is missing from');
  });

  test('rejects a malformed checksum line instead of skipping it', () => {
    const directory = stage(payloads, `${checksums(payloads)}not-a-checksum-line\n`);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      `SHA256SUMS line ${Object.keys(payloads).length + 1} is malformed: "not-a-checksum-line"`,
    );
  });

  test('rejects an unparsable digest', () => {
    const directory = stage(payloads, `zz  wtm-darwin-arm64.tar.gz\n`);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'SHA256SUMS line 1 has an unparsable SHA-256 digest: "zz"',
    );
  });

  test('rejects a duplicate checksum entry', () => {
    const directory = stage(payloads, `${checksums(payloads)}${checksums({
      'wtm-darwin-x64.tar.gz': payloads['wtm-darwin-x64.tar.gz'] as string,
    })}`);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'SHA256SUMS lists wtm-darwin-x64.tar.gz more than once',
    );
  });

  test('rejects a release that does not list both archives', () => {
    const arm64Only = { 'wtm-darwin-arm64.tar.gz': payloads['wtm-darwin-arm64.tar.gz'] as string };
    const directory = stage(arm64Only);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'SHA256SUMS does not list wtm-darwin-x64.tar.gz',
    );
  });

  test('gates one architecture against its own archive, not the release it is half of', () => {
    // Each matrix job builds a single executable. Requiring the whole release here failed a job
    // for not having produced an archive it was never asked to build, and no tag could publish.
    const arm64 = 'wtm-darwin-arm64.tar.gz';
    const directory = stage({ [arm64]: payloads[arm64] as string });

    const manifest = verifyReleaseArtifacts(request(directory, { archives: [arm64] }));

    expect(manifest.archives.map(({ name }) => name)).toEqual([arm64]);
  });

  test('rejects an empty archive selection even when the checksum document is empty', () => {
    expect(() => verifyReleaseArtifacts(request(stage({}), { archives: [] })))
      .toThrow('Release archive selection must be a non-empty, unique subset');
  });

  test('rejects duplicate and unpublished archive selections', () => {
    const name = 'wtm-darwin-arm64.tar.gz';
    expect(() => verifyReleaseArtifacts(request(stage({ [name]: payloads[name]! }), { archives: [name, name] })))
      .toThrow('Release archive selection must be a non-empty, unique subset');
    // Linux is published now; Windows is not, and a target the catalog does not publish is still
    // refused rather than quietly gated.
    const unpublished = 'wtm-win32-x64.zip';
    expect(() => verifyReleaseArtifacts(request(stage({ [unpublished]: 'local archive' }), { archives: [unpublished] })))
      .toThrow('Release archive selection must be a non-empty, unique subset');
  });

  test('rejects an architecture that ships another architecture\'s archive', () => {
    const directory = stage(payloads);

    expect(() => verifyReleaseArtifacts(request(directory, { archives: ['wtm-darwin-arm64.tar.gz'] })))
      .toThrow('SHA256SUMS lists unexpected entry wtm-darwin-x64.tar.gz');
  });

  test('rejects an unexpected checksum entry', () => {
    const directory = stage(payloads, `${checksums(payloads)}${digest('notes')}  RELEASE_NOTES.md\n`);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'SHA256SUMS lists unexpected entry RELEASE_NOTES.md',
    );
  });

  test('rejects a listed archive that is absent from the directory', () => {
    const directory = stage({ 'wtm-darwin-arm64.tar.gz': payloads['wtm-darwin-arm64.tar.gz'] as string },
      checksums(payloads));

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'Release archive wtm-darwin-x64.tar.gz is listed in SHA256SUMS but missing from',
    );
  });

  test('rejects an archive whose recomputed digest differs from the listed one', () => {
    const directory = stage(payloads, checksums({ ...payloads, 'wtm-darwin-x64.tar.gz': 'tampered payload' }));

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      `wtm-darwin-x64.tar.gz has SHA-256 ${digest(payloads['wtm-darwin-x64.tar.gz'] as string)} but SHA256SUMS lists ${digest('tampered payload')}`,
    );
  });

  test('rejects a package version that differs from the released version', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { packageVersion: '1.2.4' }))).toThrow(
      'Released version 1.2.3 does not match package version 1.2.4',
    );
  });

  test('rejects a release without executable smoke results', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { smoke: undefined }))).toThrow(
      'Release verification requires executable smoke results',
    );
    expect(() => verifyReleaseArtifacts(request(directory, { smoke: [] }))).toThrow(
      'Release verification requires executable smoke results',
    );
  });

  test('rejects a failed executable smoke result', () => {
    const directory = stage();
    const failed: readonly ReleaseSmokeCheck[] = [
      { name: 'wtm --version', passed: true },
      { name: 'wtm --help', passed: false, detail: 'exited with 1' },
    ];

    expect(() => verifyReleaseArtifacts(request(directory, { smoke: failed }))).toThrow(
      'Executable smoke check wtm --help failed: exited with 1',
    );
  });

  test('rejects an absent or unknown signing status', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { signing: undefined }))).toThrow(
      'Release verification requires a signing status of signed, adhoc, or unsigned',
    );
    expect(() => verifyReleaseArtifacts(request(directory, { signing: 'probably-fine' }))).toThrow(
      'Unknown signing status "probably-fine": expected signed, adhoc, or unsigned',
    );
  });

  test('rejects a stable release whose executable is not signed', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { signing: 'adhoc' }))).toThrow(
      'Stable release v1.2.3 requires a signed executable, found adhoc',
    );
  });

  test('accepts a prerelease whose executable is ad-hoc signed', () => {
    const directory = stage();
    const manifest = verifyReleaseArtifacts(request(directory, {
      release: { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true },
      packageVersion: '1.2.3-rc.1',
      signing: 'adhoc',
    }));

    expect(manifest.tag).toBe('v1.2.3-rc.1');
    expect(manifest.archives.map(({ name }) => name)).toEqual([
      'wtm-darwin-arm64.tar.gz',
      'wtm-darwin-x64.tar.gz',
      'wtm-linux-arm64.tar.gz',
      'wtm-linux-x64.tar.gz',
      'wtm-windows-x64.zip',
    ]);
  });

  test('rejects a release with no notarization evidence at all', () => {
    // Not the same thing as "notarization was skipped": an absent value is the workflow having
    // failed to hand the gate what it produced, which is exactly the silent wiring bug the
    // structural test in release-workflow.test.ts exists to catch. Refused for a prerelease too.
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { notarization: undefined }))).toThrow(
      'Release verification requires a notarization status of notarized or skipped',
    );
    expect(() => verifyReleaseArtifacts(request(directory, { notarization: 'maybe' }))).toThrow(
      'Unknown notarization status "maybe": expected notarized or skipped',
    );
  });

  test('rejects a stable release that was not notarized', () => {
    // Item 5's acceptance criterion, as a test: a stable release does not publish without
    // notarization. Without a ticket, a first-time user's download is killed by Gatekeeper
    // before any WTM code runs.
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { notarization: 'skipped' }))).toThrow(
      'Stable release v1.2.3 requires a notarized executable, found skipped',
    );
  });

  test('accepts a prerelease whose build skipped notarization', () => {
    // A contributor with no Apple credentials configured must still be able to cut a prerelease,
    // the same way an ad-hoc signature is tolerated for one.
    const directory = stage();

    const manifest = verifyReleaseArtifacts(request(directory, {
      release: { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true },
      packageVersion: '1.2.3-rc.1',
      signing: 'adhoc',
      notarization: 'skipped',
    }));

    expect(manifest.tag).toBe('v1.2.3-rc.1');
  });

  test('accepts a stable release that was notarized', () => {
    const directory = stage();

    const manifest = verifyReleaseArtifacts(request(directory, { notarization: 'notarized' }));

    expect(manifest.tag).toBe('v1.2.3');
  });

  test('rejects a release without performance results', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { performance: undefined }))).toThrow(
      'Release verification requires performance results',
    );
    expect(() => verifyReleaseArtifacts(request(directory, { performance: [] }))).toThrow(
      'Release verification requires performance results',
    );
  });

  test('rejects a stable release with a performance blocker', () => {
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, {
      performance: [{ blockers: 0, warnings: 1 }, { blockers: 1, warnings: 0 }],
    }))).toThrow('Stable release v1.2.3 has 1 performance blocker(s)');
  });

  test('a negative report cannot cancel another architecture\'s blocker', () => {
    expect(() => verifyReleaseArtifacts(request(stage(), {
      performance: [{ blockers: 1, warnings: 0 }, { blockers: -1, warnings: 0 }],
    }))).toThrow('non-negative safe integers');
  });

  test('rejects malformed counters at the public boundary, including for prereleases', () => {
    const directory = stage();
    const invalid = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const prerelease of [false, true]) {
      const version = prerelease ? '1.2.3-rc.1' : '1.2.3';
      for (const count of invalid) {
        for (const report of [{ blockers: count, warnings: 0 }, { blockers: 0, warnings: count }]) {
          expect(() => verifyReleaseArtifacts(request(directory, {
            release: { tag: `v${version}`, version, prerelease },
            packageVersion: version,
            performance: [report],
          }))).toThrow('non-negative safe integers');
        }
      }
    }
  });

  test('the executable rejects malformed JSON performance evidence before inspecting archives', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    for (const counters of ['-1', '0.5', '1e400', '9007199254740992']) {
      const child = runScenario(process.execPath, [join(root, 'scripts/verify-release.ts'), `v${version}`], {
        cwd: root,
        env: { ...process.env, WTM_RELEASE_PERFORMANCE: `[{"blockers":0,"warnings":${counters}}]` },
        timeoutMs: 5000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('WTM_RELEASE_PERFORMANCE');
      expect(child.stderr).toContain('non-negative safe integers');
    }
  });

  test('reports combined blocker counts exactly even above the safe number range', () => {
    expect(() => verifyReleaseArtifacts(request(stage(), {
      performance: [{ blockers: Number.MAX_SAFE_INTEGER, warnings: 0 }, { blockers: 2, warnings: 0 }],
    }))).toThrow('has 9007199254740993 performance blocker(s)');
  });

  test('accepts a stable release with performance warnings but no blockers', () => {
    const directory = stage();

    const manifest = verifyReleaseArtifacts(request(directory, {
      performance: [{ blockers: 0, warnings: 2 }, { blockers: 0, warnings: 1 }],
    }));

    expect(manifest.tag).toBe('v1.2.3');
  });

  test('accepts a prerelease despite a performance blocker', () => {
    const directory = stage();

    const manifest = verifyReleaseArtifacts(request(directory, {
      release: { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true },
      packageVersion: '1.2.3-rc.1',
      signing: 'adhoc',
      performance: [{ blockers: 3, warnings: 0 }],
    }));

    expect(manifest.tag).toBe('v1.2.3-rc.1');
  });
});

describe('the Windows archive is optional in the whole-release gate', () => {
  // CLAUDE.md states win32 CI as informational until todo item 9 lands, and item 9 has not
  // landed: a real tag whose Windows leg fails must still let macOS and Linux ship.
  const windowsZip = 'wtm-windows-x64.zip';
  function withoutWindows(): Readonly<Record<string, string>> {
    const { [windowsZip]: _omitted, ...rest } = payloads;
    return rest;
  }

  test('the whole release still passes with no Windows archive at all', () => {
    const directory = stage(withoutWindows());

    const manifest = verifyReleaseArtifacts(request(directory));

    expect(manifest.archives.map(({ name }) => name)).toEqual([
      'wtm-darwin-arm64.tar.gz',
      'wtm-darwin-x64.tar.gz',
      'wtm-linux-arm64.tar.gz',
      'wtm-linux-x64.tar.gz',
    ]);
  });

  test('still refuses the whole release if a required (non-Windows) archive is missing', () => {
    const missingLinux = Object.fromEntries(
      Object.entries(withoutWindows()).filter(([name]) => name !== 'wtm-linux-x64.tar.gz'),
    );
    const directory = stage(missingLinux);

    expect(() => verifyReleaseArtifacts(request(directory)))
      .toThrow('SHA256SUMS does not list wtm-linux-x64.tar.gz');
  });

  test('fully verifies a Windows archive when one is present', () => {
    const directory = stage();

    const manifest = verifyReleaseArtifacts(request(directory));

    expect(manifest.archives.map(({ name }) => name)).toContain(windowsZip);
    expect(manifest.archives.find(({ name }) => name === windowsZip)?.sha256)
      .toBe(digest(payloads[windowsZip] as string));
  });

  test('rejects a present but tampered Windows archive rather than silently dropping it', () => {
    const directory = stage(payloads, checksums({ ...payloads, [windowsZip]: 'tampered payload' }));

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      `${windowsZip} has SHA-256 ${digest(payloads[windowsZip] as string)} but SHA256SUMS lists ${digest('tampered payload')}`,
    );
  });

  test("a win32 leg's own gate stays exactly as strict as any other single-leg gate", () => {
    // The leniency above applies only to the whole-release default. An explicit selection (what a
    // single leg's own `release:gate` call always passes) is unaffected: still exactly that one
    // archive, required and verified, same as `linuxArm64`'s own gate already proves.
    const directory = stage({ [windowsZip]: payloads[windowsZip] as string });

    const manifest = verifyReleaseArtifacts(request(directory, {
      archives: [windowsZip], signing: releaseNotApplicable, notarization: releaseNotApplicable,
    }));

    expect(manifest.archives.map(({ name }) => name)).toEqual([windowsZip]);
    expect(() => verifyReleaseArtifacts(request(stage({}), {
      archives: [windowsZip], signing: releaseNotApplicable, notarization: releaseNotApplicable,
    }))).toThrow(`SHA256SUMS does not list ${windowsZip}`);
  });
});

describe('Apple evidence outside the darwin family', () => {
  /** What a Linux leg gates: its own archive, with no signature and no notarization ticket. */
  function linuxRequest(directory: string, overrides: Partial<ReleaseVerification> = {}): ReleaseVerification {
    return request(directory, {
      archives: [linuxArm64],
      signing: releaseNotApplicable,
      notarization: releaseNotApplicable,
      ...overrides,
    });
  }

  test('accepts a stable Linux archive that is neither signed nor notarized', () => {
    // The whole point of the scoping: `codesign`, `notarytool` and Gatekeeper are Apple facts. A
    // Linux archive has none of them and no equivalent to satisfy, so requiring `signed` and
    // `notarized` of it would refuse every stable release the moment Linux joins the matrix.
    const directory = stage({ [linuxArm64]: payloads[linuxArm64] as string });

    const manifest = verifyReleaseArtifacts(linuxRequest(directory));

    expect(manifest.tag).toBe('v1.2.3');
    expect(manifest.archives.map(({ name }) => name)).toEqual([linuxArm64]);
  });

  test('refuses Apple evidence attached to archives that cannot have it', () => {
    // A Linux leg reporting `signed` or `notarized` did not sign anything: the evidence reached
    // the gate from somewhere else, which is the wiring bug an absent status is already refused
    // for. Claiming it must not be the cheaper path than admitting it does not apply.
    const directory = stage({ [linuxArm64]: payloads[linuxArm64] as string });

    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { signing: 'signed' })))
      .toThrow(`signing status must be "${releaseNotApplicable}"`);
    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { signing: 'adhoc' })))
      .toThrow(`signing status must be "${releaseNotApplicable}"`);
    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { notarization: 'notarized' })))
      .toThrow(`notarization status must be "${releaseNotApplicable}"`);
    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { notarization: 'skipped' })))
      .toThrow(`notarization status must be "${releaseNotApplicable}"`);
  });

  test('still refuses a Linux archive with no evidence at all', () => {
    // `not-applicable` is a status the workflow states, exactly as `skipped` is. An absent value
    // remains what it has always been -- the evidence went missing on the way to the gate.
    const directory = stage({ [linuxArm64]: payloads[linuxArm64] as string });

    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { signing: undefined })))
      .toThrow('found no status at all');
    expect(() => verifyReleaseArtifacts(linuxRequest(directory, { notarization: undefined })))
      .toThrow('found no status at all');
  });

  test('never lets "not-applicable" excuse a release that ships macOS archives', () => {
    // The bypass this design has to refuse: `not-applicable` is accepted for its own platform
    // family only. A darwin leg -- or the combined gate, which covers every published archive --
    // claiming it would publish an unsigned, unnotarized macOS binary through a stable tag.
    const whole = stage();
    const darwinOnly = stage({ 'wtm-darwin-arm64.tar.gz': payloads['wtm-darwin-arm64.tar.gz'] as string });

    for (const overrides of [{ signing: releaseNotApplicable }, { notarization: releaseNotApplicable }]) {
      expect(() => verifyReleaseArtifacts(request(whole, overrides)))
        .toThrow(`publishes macOS archives, so "${releaseNotApplicable}"`);
      expect(() => verifyReleaseArtifacts(request(darwinOnly, {
        archives: ['wtm-darwin-arm64.tar.gz'],
        ...overrides,
      }))).toThrow(`publishes macOS archives, so "${releaseNotApplicable}"`);
      // A prerelease tolerates `adhoc` and `skipped`; it does not tolerate a macOS archive
      // pretending macOS signing is not a thing that applies to it.
      expect(() => verifyReleaseArtifacts(request(whole, {
        release: { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true },
        packageVersion: '1.2.3-rc.1',
        ...overrides,
      }))).toThrow(`publishes macOS archives, so "${releaseNotApplicable}"`);
    }
  });

  test('gates the whole release on the macOS evidence the darwin legs reported', () => {
    // The combined gate in `publish` covers all five archives at once. Linux and Windows riding
    // along does not dilute the macOS requirement: the stable-release rules still decide the release.
    const directory = stage();

    expect(() => verifyReleaseArtifacts(request(directory, { signing: 'adhoc' })))
      .toThrow('Stable release v1.2.3 requires a signed executable, found adhoc');
    expect(() => verifyReleaseArtifacts(request(directory, { notarization: 'skipped' })))
      .toThrow('Stable release v1.2.3 requires a notarized executable, found skipped');
    expect(verifyReleaseArtifacts(request(directory)).archives).toHaveLength(5);
  });
});

describe('release manifest', () => {
  test('orders archives by name regardless of input order', () => {
    const manifest = buildReleaseManifest({ tag: 'v1.2.3', version: '1.2.3', prerelease: false }, [
      { name: 'wtm-darwin-x64.tar.gz', bytes: 2, sha256: 'b'.repeat(64) },
      { name: 'wtm-darwin-arm64.tar.gz', bytes: 1, sha256: 'a'.repeat(64) },
    ]);

    expect(manifest).toEqual({
      version: '1.2.3',
      tag: 'v1.2.3',
      archives: [
        { name: 'wtm-darwin-arm64.tar.gz', bytes: 1, sha256: 'a'.repeat(64) },
        { name: 'wtm-darwin-x64.tar.gz', bytes: 2, sha256: 'b'.repeat(64) },
      ],
    });
  });

  test('serializes deterministically', () => {
    const release = { tag: 'v1.2.3', version: '1.2.3', prerelease: false };
    const archives = [{ name: 'wtm-darwin-arm64.tar.gz', bytes: 1, sha256: 'a'.repeat(64) }];

    expect(JSON.stringify(buildReleaseManifest(release, archives)))
      .toBe(JSON.stringify(buildReleaseManifest(release, [...archives])));
  });
});
