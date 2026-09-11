import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactTargetFor, type ArtifactTarget } from './artifact-targets';

/** A release archive carries the executable and the notices that must travel with it. */
export const releaseArchiveFiles = ['wtm', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md'] as const;

const machoArchitectures: Readonly<Record<string, string>> = { arm64: 'arm64', x64: 'x86_64' };

export interface ReleaseHost {
  root: string;
  platform: string;
  arch: string;
  run(command: string, args: readonly string[]): { status: number; stdout: string; stderr: string };
  readPrefix(path: string, maxBytes: number): Uint8Array;
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
  // Reject unsupported hosts before reading, staging or removing any path.
  const target = artifactTargetFor(host.platform, host.arch);
  const executable = join(host.root, 'dist/sea', target.executableName);
  assertArchitecture(host, executable, target);

  const outputDirectory = join(host.root, 'dist/release');
  const stage = join(outputDirectory, '.stage');
  const archive = join(outputDirectory, target.archiveName);
  const checksums = join(outputDirectory, 'SHA256SUMS');

  host.remove(stage);
  host.makeDirectory(stage);
  try {
    for (const file of releaseArchiveFiles) {
      host.copyFile(file === 'wtm' ? executable : join(host.root, file), join(stage, file));
    }
    host.chmod(join(stage, 'wtm'), 0o755);
    check(host, '/usr/bin/tar', [
      ...(target.platform === 'darwin'
        ? ['--no-mac-metadata', '--numeric-owner', '--uid', '0', '--gid', '0']
        : ['--numeric-owner', '--owner', '0', '--group', '0']),
      '-czf', archive,
      '-C', stage,
      ...releaseArchiveFiles,
    ]);
  } finally {
    host.remove(stage);
  }
  const sha256 = host.digest(archive);
  host.writeFile(checksums, checksumDocument([{ name: target.archiveName, sha256 }]));
  return { archive, checksums, sha256 };
}

export function checksumDocument(entries: ReadonlyArray<{ name: string; sha256: string }>): string {
  return [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}

function assertArchitecture(host: ReleaseHost, executable: string, target: ArtifactTarget): void {
  if (target.platform === 'linux') {
    const bytes = host.readPrefix(executable, 64);
    if (bytes.byteLength !== 64) throw new Error(`${executable} has an invalid ELF header length`);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // ELF64 little-endian x86-64, either ET_EXEC or ET_DYN (the pinned Node runtime is PIE).
    // Classifying only the header is an architecture check; executable smoke remains a separate gate.
    if (header.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
      || ![2, 3].includes(header.getUint16(16, true)) || header.getUint16(18, true) !== 62
      || header.getUint32(20, true) !== 1 || header.getUint16(52, true) !== 64) {
      throw new Error(`${executable} is not an ELF64 little-endian x86-64 executable`);
    }
    return;
  }
  const expected = machoArchitectures[target.arch];
  const described = check(host, '/usr/bin/file', ['--brief', '--', executable]);
  if (!described.includes('Mach-O') || !new RegExp(`\\b${expected}\\b`).test(described)) {
    throw new Error(`${executable} is not a Mach-O ${expected} executable: ${described.trim()}`);
  }
}

export function createReleaseHost(): ReleaseHost {
  return {
    root: resolve(fileURLToPath(import.meta.url), '../..'),
    platform: process.platform,
    arch: process.arch,
    run(command, args) {
      const result = spawnSync(command, [...args], { encoding: 'utf8' });
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    readPrefix(path, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64) throw new RangeError('Archive header reads are limited to 64 bytes');
      const bytes = Buffer.alloc(maxBytes);
      // A FIFO can block at open, before the byte limit matters. Inspect the opened descriptor
      // rather than relying on an lstat whose pathname could change before open.
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        if (!fstatSync(fd).isFile()) throw new Error('Archive header input must be a regular file');
        let offset = 0;
        while (offset < maxBytes) {
          const read = readSync(fd, bytes, offset, maxBytes - offset, offset);
          if (read === 0) break;
          offset += read;
        }
        return bytes.subarray(0, offset);
      } finally { closeSync(fd); }
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
