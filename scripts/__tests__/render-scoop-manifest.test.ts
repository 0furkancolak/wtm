import { describe, expect, test } from 'bun:test';
import {
  manifestArchiveName,
  renderScoopManifest,
  resolveManifestInput,
} from '../render-scoop-manifest';

const digest = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const rendered = renderScoopManifest({ version: '1.2.3', x64Sha256: digest });
const parsed = JSON.parse(rendered) as Record<string, unknown>;

describe('manifest metadata', () => {
  test('declares version, description, homepage, and license', () => {
    expect(parsed.version).toBe('1.2.3');
    expect(parsed.description).toBe('Local-first runtime and safety manager for Git worktrees');
    expect(parsed.homepage).toBe('https://github.com/0furkancolak/wtm');
    expect(parsed.license).toBe('Apache-2.0');
  });

  test('pairs the immutable release URL with its own digest', () => {
    expect(parsed.url).toBe(
      `https://github.com/0furkancolak/wtm/releases/download/v1.2.3/${manifestArchiveName}`,
    );
    expect(parsed.hash).toBe(`sha256:${digest}`);
  });

  test('names the archive the release pipeline produces', () => {
    expect(manifestArchiveName).toBe('wtm-windows-x64.zip');
  });

  test('installs the extracted executable directly', () => {
    expect(parsed.bin).toBe('wtm.exe');
  });

  test('carries exactly the getting-started notes', () => {
    expect(parsed.notes).toEqual([
      'Run `wtm init --yes` inside a workspace to get started.',
      'Run `wtm daemon install` to supervise tasks in the background.',
    ]);
  });
});

describe('determinism', () => {
  test('renders byte-identical output for identical inputs', () => {
    expect(renderScoopManifest({ version: '1.2.3', x64Sha256: digest })).toBe(rendered);
  });

  test('leaves no unsubstituted placeholder', () => {
    expect(rendered).not.toMatch(/\{\{|\}\}/);
  });

  test('renders syntactically valid JSON', () => {
    expect(() => JSON.parse(rendered)).not.toThrow();
  });
});

describe('input validation', () => {
  test('rejects a version that is not valid SemVer', () => {
    for (const version of ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '']) {
      expect(() => renderScoopManifest({ version, x64Sha256: digest })).toThrow(/SemVer/);
    }
  });

  test('rejects a digest that is not 64 lowercase hex characters', () => {
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
      expect(() => renderScoopManifest({ version: '1.2.3', x64Sha256: bad })).toThrow(/x64Sha256/);
    }
  });

  test('rejects a missing digest', () => {
    expect(() => renderScoopManifest({ version: '1.2.3' } as never)).toThrow(/x64Sha256/);
  });
});

describe('command line input resolution', () => {
  const checksums = `${digest}  ${manifestArchiveName}\n`;

  test('accepts an explicit version and digest pair', () => {
    expect(resolveManifestInput(['1.2.3', digest], failingReader))
      .toEqual({ version: '1.2.3', x64Sha256: digest });
  });

  test('reads the digest from a SHA256SUMS document', () => {
    expect(resolveManifestInput(['1.2.3', '--checksums', 'SHA256SUMS'], () => checksums))
      .toEqual({ version: '1.2.3', x64Sha256: digest });
  });

  test('rejects a checksum document missing the expected archive', () => {
    expect(() => resolveManifestInput(
      ['1.2.3', '--checksums', 'SHA256SUMS'],
      () => `${digest}  wtm-darwin-arm64.tar.gz\n`,
    )).toThrow(/wtm-windows-x64\.zip/);
  });

  test('rejects arguments it cannot interpret', () => {
    expect(() => resolveManifestInput([], failingReader)).toThrow(/usage/i);
  });
});

function failingReader(path: string): string {
  throw new Error(`unexpected read of ${path}`);
}
