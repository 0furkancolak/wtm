import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formulaArchiveNames,
  renderHomebrewFormula,
  resolveFormulaInput,
} from '../render-homebrew-formula';

const root = fileURLToPath(new URL('../..', import.meta.url));
const armDigest = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const intelDigest = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const rendered = renderHomebrewFormula({
  version: '1.2.3',
  arm64Sha256: armDigest,
  x64Sha256: intelDigest,
});

describe('formula metadata', () => {
  test('declares the class, description, homepage, version, and license', () => {
    expect(rendered).toContain('class Wtm < Formula');
    expect(rendered).toMatch(/^ {2}desc "\S.*"$/m);
    expect(rendered).toContain('homepage "https://github.com/0furkancolak/wtm"');
    expect(rendered).toContain('version "1.2.3"');
    expect(rendered).toContain('license "Apache-2.0"');
  });

  test('installs the extracted binary directly', () => {
    expect(rendered).toContain('bin.install "wtm"');
  });

  test('carries exactly the branded caveats', () => {
    expect(rendered).toContain([
      '  def caveats',
      '    <<~EOS',
      '      WTM installed — Powered by https://nafru.com',
      '      Run `wtm init --yes` inside a workspace to get started.',
      '    EOS',
      '  end',
    ].join('\n'));
  });
});

describe('architecture blocks', () => {
  const blocks = new Map(
    [...rendered.matchAll(/^ {2}(on_arm|on_intel) do\n([\s\S]*?)^ {2}end$/gm)]
      .map((match) => [match[1] as string, match[2] as string]),
  );

  test('pairs each immutable release URL with its own digest', () => {
    expect(blocks.get('on_arm')).toContain(
      `url "https://github.com/0furkancolak/wtm/releases/download/v1.2.3/${formulaArchiveNames.arm64}"`,
    );
    expect(blocks.get('on_arm')).toContain(`sha256 "${armDigest}"`);
    expect(blocks.get('on_intel')).toContain(
      `url "https://github.com/0furkancolak/wtm/releases/download/v1.2.3/${formulaArchiveNames.x64}"`,
    );
    expect(blocks.get('on_intel')).toContain(`sha256 "${intelDigest}"`);
  });

  test('never leaks a digest into the other architecture', () => {
    expect(blocks.get('on_arm')).not.toContain(intelDigest);
    expect(blocks.get('on_intel')).not.toContain(armDigest);
  });

  test('names the archives the release pipeline produces', () => {
    expect(formulaArchiveNames).toEqual({
      arm64: 'wtm-darwin-arm64.tar.gz',
      x64: 'wtm-darwin-x64.tar.gz',
    });
  });
});

describe('formula test block', () => {
  const block = /^ {2}test do\n([\s\S]*?)^ {2}end$/m.exec(rendered)?.[1] ?? '';

  test('exercises --version and --help against the installed binary', () => {
    expect(block).toContain('#{bin}/wtm --version');
    expect(block).toContain('#{bin}/wtm --help');
    expect(block).toContain('assert_match');
  });

  test('runs sandboxed, without touching real state or the network', () => {
    expect(block).toContain('ENV["HOME"] = testpath');
    expect(block).not.toMatch(/\b(?:curl|system\s|daemon|init)\b/);
  });
});

describe('determinism', () => {
  test('renders byte-identical output for identical inputs', () => {
    expect(renderHomebrewFormula({
      version: '1.2.3',
      arm64Sha256: armDigest,
      x64Sha256: intelDigest,
    })).toBe(rendered);
  });

  test('leaves no unsubstituted placeholder', () => {
    expect(rendered).not.toMatch(/\{\{|\}\}/);
  });
});

describe('input validation', () => {
  test('rejects a version that is not valid SemVer', () => {
    for (const version of ['1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '']) {
      expect(() => renderHomebrewFormula({
        version,
        arm64Sha256: armDigest,
        x64Sha256: intelDigest,
      })).toThrow(/SemVer/);
    }
  });

  test('rejects a digest that is not 64 lowercase hex characters', () => {
    for (const digest of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}z`]) {
      expect(() => renderHomebrewFormula({
        version: '1.2.3',
        arm64Sha256: digest,
        x64Sha256: intelDigest,
      })).toThrow(/arm64Sha256/);
      expect(() => renderHomebrewFormula({
        version: '1.2.3',
        arm64Sha256: armDigest,
        x64Sha256: digest,
      })).toThrow(/x64Sha256/);
    }
  });

  test('rejects a missing digest', () => {
    expect(() => renderHomebrewFormula({
      version: '1.2.3',
      arm64Sha256: '',
      x64Sha256: intelDigest,
    })).toThrow(/arm64Sha256/);
    expect(() => renderHomebrewFormula({
      version: '1.2.3',
      arm64Sha256: armDigest,
    } as never)).toThrow(/x64Sha256/);
  });
});

describe('command line input resolution', () => {
  const checksums = `${intelDigest}  wtm-darwin-x64.tar.gz\n${armDigest}  wtm-darwin-arm64.tar.gz\n`;

  test('accepts an explicit version and digest pair', () => {
    expect(resolveFormulaInput(['1.2.3', armDigest, intelDigest], failingReader))
      .toEqual({ version: '1.2.3', arm64Sha256: armDigest, x64Sha256: intelDigest });
  });

  test('reads both digests from a SHA256SUMS document', () => {
    expect(resolveFormulaInput(['1.2.3', '--checksums', 'SHA256SUMS'], () => checksums))
      .toEqual({ version: '1.2.3', arm64Sha256: armDigest, x64Sha256: intelDigest });
  });

  test('rejects a checksum document missing an expected archive', () => {
    expect(() => resolveFormulaInput(
      ['1.2.3', '--checksums', 'SHA256SUMS'],
      () => `${armDigest}  wtm-darwin-arm64.tar.gz\n`,
    )).toThrow(/wtm-darwin-x64\.tar\.gz/);
  });

  test('rejects arguments it cannot interpret', () => {
    expect(() => resolveFormulaInput([], failingReader)).toThrow(/usage/i);
    expect(() => resolveFormulaInput(['1.2.3'], failingReader)).toThrow(/usage/i);
  });
});

describe.skipIf(!existsSync('/usr/bin/ruby'))('ruby syntax', () => {
  test('renders a formula the Ruby parser accepts', () => {
    const path = join(root, 'artifacts/formula/wtm.rb');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, rendered, { mode: 0o600 });

    const result = spawnSync('/usr/bin/ruby', ['-c', path], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('Syntax OK');
  });
});

function failingReader(path: string): string {
  throw new Error(`unexpected read of ${path}`);
}
