import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A release archive carries the executable and the notices that must travel with it. */
export const releaseArchiveFiles = ['wtm', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md'] as const;

const machoArchitectures: Readonly<Record<string, string>> = { arm64: 'arm64', x64: 'x86_64' };

export interface ReleaseHost {
  root: string;
  arch: string;
  run(command: string, args: readonly string[]): { status: number; stdout: string; stderr: string };
  digest(path: string): string;
  writeFile(path: string, contents: string): void;
  copyFile(source: string, destination: string): void;
  chmod(path: string, mode: number): void;
  makeDirectory(path: string): void;
  remove(path: string): void;
}

export interface ReleaseArtifacts {
  archive: string;
  checksums: string;
  sha256: string;
}

export async function buildReleaseArtifacts(host: ReleaseHost): Promise<ReleaseArtifacts> {
  const executable = join(host.root, 'dist/sea/wtm');
  assertArchitecture(host, executable);

  const outputDirectory = join(host.root, 'dist/release');
  const stage = join(outputDirectory, '.stage');
  const archive = join(outputDirectory, `wtm-darwin-${host.arch}.tar.gz`);
  const checksums = join(outputDirectory, 'SHA256SUMS');

  host.remove(stage);
  host.makeDirectory(stage);
  try {
    for (const file of releaseArchiveFiles) {
      host.copyFile(file === 'wtm' ? executable : join(host.root, file), join(stage, file));
    }
    host.chmod(join(stage, 'wtm'), 0o755);
    check(host, '/usr/bin/tar', [
      '--no-mac-metadata', '--numeric-owner', '--uid', '0', '--gid', '0',
      '-czf', archive,
      '-C', stage,
      ...releaseArchiveFiles,
    ]);
  } finally {
    host.remove(stage);
  }
  const sha256 = host.digest(archive);
  host.writeFile(checksums, checksumDocument([{ name: `wtm-darwin-${host.arch}.tar.gz`, sha256 }]));
  return { archive, checksums, sha256 };
}

export function checksumDocument(entries: ReadonlyArray<{ name: string; sha256: string }>): string {
  return [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}

function assertArchitecture(host: ReleaseHost, executable: string): void {
  const expected = machoArchitectures[host.arch];
  if (expected === undefined) throw new Error(`Unsupported release architecture ${host.arch}`);
  const described = check(host, '/usr/bin/file', ['--brief', '--', executable]);
  if (!described.includes('Mach-O') || !new RegExp(`\\b${expected}\\b`).test(described)) {
    throw new Error(`${executable} is not a Mach-O ${expected} executable: ${described.trim()}`);
  }
}

export function createReleaseHost(): ReleaseHost {
  return {
    root: resolve(fileURLToPath(import.meta.url), '../..'),
    arch: process.arch,
    run(command, args) {
      const result = spawnSync(command, [...args], { encoding: 'utf8' });
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); },
    writeFile(path, contents) { writeFileSync(path, contents, { mode: 0o600 }); },
    copyFile(source, destination) { copyFileSync(source, destination); },
    chmod(path, mode) { chmodSync(path, mode); },
    makeDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); },
    remove(path) { rmSync(path, { recursive: true, force: true }); },
  };
}

function check(host: ReleaseHost, command: string, args: readonly string[]): string {
  const result = host.run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

if (import.meta.main) {
  const result = await buildReleaseArtifacts(createReleaseHost());
  process.stdout.write(`${result.archive}\n${result.sha256}  ${result.archive.split('/').at(-1)}\n`);
}
