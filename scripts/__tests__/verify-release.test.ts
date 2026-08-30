import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReleaseManifest,
  verifyReleaseArtifacts,
  verifyReleaseTag,
  type ReleaseSmokeCheck,
  type ReleaseVerification,
} from '../verify-release';

const payloads: Readonly<Record<string, string>> = {
  'wtm-darwin-arm64.tar.gz': 'arm64 archive payload',
  'wtm-darwin-x64.tar.gz': 'x64 archive payload',
};
const smoke: readonly ReleaseSmokeCheck[] = [{ name: 'wtm --version', passed: true }];
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
      archives: [
        {
          name: 'wtm-darwin-arm64.tar.gz',
          bytes: Buffer.byteLength(payloads['wtm-darwin-arm64.tar.gz'] as string),
          sha256: digest(payloads['wtm-darwin-arm64.tar.gz'] as string),
        },
        {
          name: 'wtm-darwin-x64.tar.gz',
          bytes: Buffer.byteLength(payloads['wtm-darwin-x64.tar.gz'] as string),
          sha256: digest(payloads['wtm-darwin-x64.tar.gz'] as string),
        },
      ],
    });
  });

  test('rejects a staged release without SHA256SUMS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wtm-verify-release-'));
    temporaries.push(directory);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow('SHA256SUMS is missing from');
  });

  test('rejects a malformed checksum line instead of skipping it', () => {
    const directory = stage(payloads, `${checksums(payloads)}not-a-checksum-line\n`);

    expect(() => verifyReleaseArtifacts(request(directory))).toThrow(
      'SHA256SUMS line 3 is malformed: "not-a-checksum-line"',
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
    ]);
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
