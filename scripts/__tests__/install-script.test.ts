import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Exercises `install.sh` as a real child process against a local HTTP fixture server standing in
 * for GitHub Releases (CLAUDE.md: tests never reach the network). `install.ps1` cannot be run the
 * same way — no `pwsh`/`powershell` binary exists in this sandbox (verified: `which pwsh
 * powershell` finds neither) — so it gets only the structural checks below the `install.sh`
 * suite. Neither script has been proven against a real multi-platform GitHub release: only the
 * macOS-only `v0.1.0-rc.1` prerelease has ever been published (see README.md and
 * docs/12-open-source-distribution.md), so the Linux/Windows archive names these scripts expect
 * are exercised here only through this fixture, never against a real tag.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const installShPath = join(root, 'install.sh');
const installPs1Path = join(root, 'install.ps1');

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds a real, small tar.gz containing a single executable file named `wtm`. */
function buildFixtureArchive(scriptContent: string): { bytes: Buffer; sha256: string } {
  const stageDir = mkdtempSync(join(tmpdir(), 'wtm-install-fixture-'));
  try {
    const wtmPath = join(stageDir, 'wtm');
    writeFileSync(wtmPath, scriptContent);
    // The mode the staged file carries into the archive does not matter to install.sh, which
    // always re-chmods 0755 itself — mirrored here only because a real release archive does too.
    spawnSync('chmod', ['0755', wtmPath]);
    const archivePath = join(stageDir, 'archive.tar.gz');
    const tarResult = spawnSync('tar', ['-czf', archivePath, '-C', stageDir, 'wtm'], { encoding: 'utf8' });
    if (tarResult.status !== 0) {
      throw new Error(`fixture tar failed: ${tarResult.stderr || tarResult.stdout}`);
    }
    const bytes = readFileSync(archivePath);
    return { bytes, sha256: sha256Hex(bytes) };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

interface FixtureRelease {
  archiveName: string;
  archiveBytes: Buffer;
  sums: string;
}

interface FixtureState {
  latestTag: string;
  releases: Map<string, FixtureRelease>;
  requests: string[];
}

let state: FixtureState = { latestTag: '', releases: new Map(), requests: [] };
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      state.requests.push(url.pathname);
      if (url.pathname === '/releases/latest') {
        if (state.latestTag === '') return new Response('no latest release configured', { status: 404 });
        return new Response(null, { status: 302, headers: { Location: `${baseUrl}/releases/tag/${state.latestTag}` } });
      }
      if (url.pathname.startsWith('/releases/tag/')) {
        return new Response('ok', { status: 200 });
      }
      const match = /^\/releases\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (match !== null) {
        const [, tag, file] = match;
        const release = tag === undefined ? undefined : state.releases.get(tag);
        if (release === undefined) return new Response('not found', { status: 404 });
        if (file === 'SHA256SUMS') return new Response(release.sums, { status: 200 });
        if (file === release.archiveName) return new Response(new Uint8Array(release.archiveBytes), { status: 200 });
        return new Response('not found', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const tempDirs: string[] = [];

beforeEach(() => {
  state = { latestTag: '', releases: new Map(), requests: [] };
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function freshPrefix(): string {
  const prefix = mkdtempSync(join(tmpdir(), 'wtm-install-prefix-'));
  tempDirs.push(prefix);
  return prefix;
}

/** The Linux x64 archive install.sh resolves for `WTM_INSTALL_OS=Linux WTM_INSTALL_ARCH=x86_64`. */
const linuxX64Archive = 'wtm-linux-x64.tar.gz';

/**
 * Runs install.sh as a real child process, via `Bun.spawn` rather than `spawnSync`. The fixture
 * HTTP server above lives in this same process, single-threaded event loop and all — a *blocking*
 * spawn (`spawnSync`) would freeze that loop while the child's `curl` tries to reach it, and
 * parent and child would deadlock waiting on each other. `Bun.spawn` is async, so the event loop
 * keeps serving fixture requests while the shell script runs.
 */
async function runInstallSh(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['sh', installShPath, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutId = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, 20_000);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeoutId);
  }
}

describe('install.sh against a fixture release server', () => {
  test('a clean install places the executable at the expected path and marks it executable', async () => {
    const { bytes, sha256 } = buildFixtureArchive(
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'9.9.9-fixture\\n\'; exit 0; fi\necho stub\n',
    );
    const tag = 'v9.9.9-fixture-clean';
    state.latestTag = tag;
    state.releases.set(tag, { archiveName: linuxX64Archive, archiveBytes: bytes, sums: `${sha256}  ${linuxX64Archive}\n` });
    const prefix = freshPrefix();

    // No WTM_INSTALL_VERSION here: this also exercises the "resolve latest via releases/latest
    // redirect" path, not just an explicitly pinned version.
    const result = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'x86_64',
    });

    expect(result.status, result.stderr).toBe(0);
    const installedPath = join(prefix, 'bin', 'wtm');
    expect(existsSync(installedPath)).toBe(true);
    expect(statSync(installedPath).mode & 0o777).toBe(0o755);
    expect(result.stdout).toContain('9.9.9-fixture');
    expect(result.stdout.toLowerCase()).toContain('doctor');
    expect(state.requests).toContain('/releases/latest');
  });

  test('a tampered SHA256SUMS entry fails loudly and installs nothing', async () => {
    const { bytes } = buildFixtureArchive('#!/bin/sh\necho stub\n');
    const tag = 'v9.9.9-fixture-tampered';
    const wrongDigest = 'f'.repeat(64);
    state.releases.set(tag, { archiveName: linuxX64Archive, archiveBytes: bytes, sums: `${wrongDigest}  ${linuxX64Archive}\n` });
    const prefix = freshPrefix();

    const result = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_VERSION: tag,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'x86_64',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('checksum');
    expect(existsSync(join(prefix, 'bin', 'wtm'))).toBe(false);
  });

  test('re-running against an existing install succeeds and overwrites it (upgrade path)', async () => {
    const prefix = freshPrefix();
    const first = buildFixtureArchive("#!/bin/sh\nprintf 'first-install-marker\\n'\n");
    const tagA = 'v1.0.0-fixture-a';
    state.releases.set(tagA, { archiveName: linuxX64Archive, archiveBytes: first.bytes, sums: `${first.sha256}  ${linuxX64Archive}\n` });

    const resultA = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_VERSION: tagA,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'x86_64',
    });
    expect(resultA.status, resultA.stderr).toBe(0);
    const installedPath = join(prefix, 'bin', 'wtm');
    expect(readFileSync(installedPath, 'utf8')).toContain('first-install-marker');

    const second = buildFixtureArchive("#!/bin/sh\nprintf 'second-install-marker\\n'\n");
    const tagB = 'v1.0.1-fixture-b';
    state.releases.set(tagB, { archiveName: linuxX64Archive, archiveBytes: second.bytes, sums: `${second.sha256}  ${linuxX64Archive}\n` });

    const resultB = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_VERSION: tagB,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'x86_64',
    });
    expect(resultB.status, resultB.stderr).toBe(0);
    expect(readFileSync(installedPath, 'utf8')).toContain('second-install-marker');
    expect(readFileSync(installedPath, 'utf8')).not.toContain('first-install-marker');
    expect(statSync(installedPath).mode & 0o777).toBe(0o755);
  });

  test('an unsupported OS/arch fails with a clear message instead of downloading anything', async () => {
    const prefix = freshPrefix();

    const result = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'SunOS',
      WTM_INSTALL_ARCH: 'sparc64',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('unsupported');
    expect(result.stderr).toContain('SunOS');
    expect(result.stderr).toContain('sparc64');
    expect(existsSync(join(prefix, 'bin', 'wtm'))).toBe(false);
    // Detection is refused before any network call, so nothing was requested at all — the whole
    // point of failing loudly here rather than guessing an archive name.
    expect(state.requests).toEqual([]);
  });

  test('an unsupported architecture on a supported OS also fails before downloading', async () => {
    const prefix = freshPrefix();

    const result = await runInstallSh([], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_PREFIX: prefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'mips64',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain('unsupported');
    expect(existsSync(join(prefix, 'bin', 'wtm'))).toBe(false);
    expect(state.requests).toEqual([]);
  });

  test('--prefix overrides WTM_INSTALL_PREFIX and installs to <prefix>/bin', async () => {
    const { bytes, sha256 } = buildFixtureArchive('#!/bin/sh\necho stub\n');
    const tag = 'v9.9.9-fixture-flag-prefix';
    state.releases.set(tag, { archiveName: linuxX64Archive, archiveBytes: bytes, sums: `${sha256}  ${linuxX64Archive}\n` });
    const envPrefix = freshPrefix();
    const flagPrefix = freshPrefix();

    const result = await runInstallSh(['--version', tag, '--prefix', flagPrefix], {
      WTM_INSTALL_BASE_URL: baseUrl,
      WTM_INSTALL_PREFIX: envPrefix,
      WTM_INSTALL_OS: 'Linux',
      WTM_INSTALL_ARCH: 'x86_64',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(flagPrefix, 'bin', 'wtm'))).toBe(true);
    expect(existsSync(join(envPrefix, 'bin', 'wtm'))).toBe(false);
  });
});

describe('install.ps1 structural checks (no pwsh/powershell in this sandbox — never executed)', () => {
  test('the file exists and is non-empty', () => {
    expect(existsSync(installPs1Path)).toBe(true);
    const contents = readFileSync(installPs1Path, 'utf8');
    expect(contents.length).toBeGreaterThan(500);
  });

  test('braces, parentheses, brackets and quotes balance (lightweight sanity scan, not a parser)', () => {
    const contents = readFileSync(installPs1Path, 'utf8');
    const count = (needle: string) => contents.split(needle).length - 1;

    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
    expect(count('[')).toBe(count(']'));
    expect(count("'") % 2).toBe(0);
    expect(count('"') % 2).toBe(0);
  });

  test('declares the required parameters and fail-fast preference', () => {
    const contents = readFileSync(installPs1Path, 'utf8');
    expect(contents).toContain('$ErrorActionPreference = \'Stop\'');
    expect(contents).toContain('[CmdletBinding()]');
    expect(contents).toContain('[string]$Version');
    expect(contents).toContain('[string]$Prefix');
    expect(contents).toContain('WTM_INSTALL_VERSION');
    expect(contents).toContain('WTM_INSTALL_PREFIX');
    expect(contents).toContain('WTM_INSTALL_BASE_URL');
    expect(contents).toContain('WTM_INSTALL_OS');
    expect(contents).toContain('WTM_INSTALL_ARCH');
    expect(contents).toContain('Get-FileHash');
    expect(contents).toContain('wtm-windows-x64.zip');
    expect(contents).toContain('Expand-Archive');
  });

  test('states plainly that it has never been executed', () => {
    const contents = readFileSync(installPs1Path, 'utf8');
    expect(contents).toContain('never been executed');
  });
});
