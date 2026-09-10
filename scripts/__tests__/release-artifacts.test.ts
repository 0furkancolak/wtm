import { describe, expect, test } from 'bun:test';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseArtifacts,
  checksumDocument,
  releaseArchiveFiles,
  type ReleaseHost,
} from '../release-artifacts';

const root = fileURLToPath(new URL('../..', import.meta.url));

interface Recording {
  commands: Array<{ command: string; args: readonly string[] }>;
  reads: Array<{ path: string; maxBytes: number }>;
  writes: Map<string, string>;
  copies: Array<{ source: string; destination: string }>;
  modes: Array<{ path: string; mode: number }>;
  directories: string[];
  removed: string[];
  digests: string[];
}

type FixtureReleaseHost = ReleaseHost & {
  platform: string;
  readPrefix(path: string, maxBytes: number): Uint8Array;
};

function elfHeader(type = 3): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}

function createHost(overrides: Partial<FixtureReleaseHost> = {}): { host: FixtureReleaseHost; recording: Recording } {
  const recording: Recording = { commands: [], reads: [], writes: new Map(), copies: [], modes: [],
    directories: [], removed: [], digests: [] };
  const host: FixtureReleaseHost = {
    root,
    platform: 'darwin',
    arch: 'arm64',
    run(command, args) {
      recording.commands.push({ command, args });
      return command === '/usr/bin/file'
        ? { status: 0, stdout: `${args.at(-1)}: Mach-O 64-bit executable ${host.arch === 'x64' ? 'x86_64' : 'arm64'}\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    },
    readPrefix(path, maxBytes) { recording.reads.push({ path, maxBytes }); return elfHeader(); },
    digest(path) { recording.digests.push(path); return 'a'.repeat(64); },
    writeFile(path, contents) { recording.writes.set(path, contents); },
    copyFile(source, destination) { recording.copies.push({ source, destination }); },
    chmod(path, mode) { recording.modes.push({ path, mode }); },
    makeDirectory(path) { recording.directories.push(path); },
    remove(path) { recording.removed.push(path); },
    ...overrides,
  };
  return { host, recording };
}

describe('release archive assembly', () => {
  test('stages exactly the executable, license, notice, and third-party notices', async () => {
    const { host, recording } = createHost();

    const result = await buildReleaseArtifacts(host);

    expect(releaseArchiveFiles).toEqual(['wtm', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md']);
    expect(recording.copies.map(({ destination }) => basename(destination)))
      .toEqual([...releaseArchiveFiles]);
    expect(recording.modes).toContainEqual({
      path: join(root, 'dist/release/.stage/wtm'),
      mode: 0o755,
    });
    expect(result.archive).toBe(join(root, 'dist/release/wtm-darwin-arm64.tar.gz'));
  });

  test('archives the staged directory through a deterministic tar invocation', async () => {
    const { host, recording } = createHost();

    const result = await buildReleaseArtifacts(host);

    expect(recording.commands).toContainEqual({
      command: '/usr/bin/tar',
      args: [
        '--no-mac-metadata', '--numeric-owner', '--uid', '0', '--gid', '0',
        '-czf', result.archive,
        '-C', join(root, 'dist/release/.stage'),
        ...releaseArchiveFiles,
      ],
    });
  });

  test('rejects an executable whose Mach-O architecture is not the declared one', async () => {
    const { host } = createHost({
      arch: 'x64',
      run(command, args) {
        return command === '/usr/bin/file'
          ? { status: 0, stdout: `${args.at(-1)}: Mach-O 64-bit executable arm64\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      },
    });

    await expect(buildReleaseArtifacts(host)).rejects.toThrow('x86_64');
  });

  test('keeps the Darwin Intel archive name and Mach-O verification', async () => {
    const { host, recording } = createHost({ arch: 'x64' });

    const result = await buildReleaseArtifacts(host);

    expect(result.archive).toBe(join(root, 'dist/release/wtm-darwin-x64.tar.gz'));
    expect(recording.commands[0]).toEqual({
      command: '/usr/bin/file', args: ['--brief', '--', join(root, 'dist/sea/wtm')],
    });
    expect(recording.reads).toEqual([]);
  });
});

describe('local Linux x64 archive assembly', () => {
  for (const type of [2, 3]) {
    test(`accepts an ELF64 x86-64 ${type === 2 ? 'executable' : 'PIE'} using a bounded header read`, async () => {
      const { host, recording } = createHost({ platform: 'linux', arch: 'x64' });
      host.readPrefix = (path, maxBytes) => {
        recording.reads.push({ path, maxBytes }); return elfHeader(type);
      };

      const result = await buildReleaseArtifacts(host);

      expect(recording.reads).toEqual([{ path: join(root, 'dist/sea/wtm'), maxBytes: 64 }]);
      expect(result.archive).toBe(join(root, 'dist/release/wtm-linux-x64.tar.gz'));
      expect(recording.commands).toEqual([{
        command: '/usr/bin/tar',
        args: ['--numeric-owner', '--owner', '0', '--group', '0', '-czf', result.archive,
          '-C', join(root, 'dist/release/.stage'), ...releaseArchiveFiles],
      }]);
      expect(recording.copies.map(({ destination }) => basename(destination))).toEqual([...releaseArchiveFiles]);
      expect(recording.modes).toEqual([{ path: join(root, 'dist/release/.stage/wtm'), mode: 0o755 }]);
      expect(recording.digests).toEqual([result.archive]);
      expect(recording.writes.get(result.checksums)).toBe(`${'a'.repeat(64)}  wtm-linux-x64.tar.gz\n`);
    });
  }

  for (const [name, corrupt] of [
    ['bad magic', (bytes: Buffer) => { bytes[0] = 0; }],
    ['32-bit class', (bytes: Buffer) => { bytes[4] = 1; }],
    ['big-endian encoding', (bytes: Buffer) => { bytes[5] = 2; }],
    ['unknown identification version', (bytes: Buffer) => { bytes[6] = 0; }],
    ['relocatable object', (bytes: Buffer) => { bytes.writeUInt16LE(1, 16); }],
    ['core dump', (bytes: Buffer) => { bytes.writeUInt16LE(4, 16); }],
    ['ARM64 machine', (bytes: Buffer) => { bytes.writeUInt16LE(183, 18); }],
    ['i386 machine', (bytes: Buffer) => { bytes.writeUInt16LE(3, 18); }],
    ['unknown header version', (bytes: Buffer) => { bytes.writeUInt32LE(0, 20); }],
    ['invalid header size', (bytes: Buffer) => { bytes.writeUInt16LE(63, 52); }],
  ] as const) {
    test(`rejects ${name} before staging or checksumming any output`, async () => {
      const bytes = elfHeader(); corrupt(bytes);
      const { host, recording } = createHost({ platform: 'linux', arch: 'x64', readPrefix: () => bytes });

      await expect(buildReleaseArtifacts(host)).rejects.toThrow('ELF');

      expect(recording.commands).toEqual([]);
      expect(recording.copies).toEqual([]);
      expect(recording.directories).toEqual([]);
      expect(recording.removed).toEqual([]);
      expect(recording.writes.size).toBe(0);
      expect(recording.digests).toEqual([]);
    });
  }

  test('rejects a truncated ELF header without staging output', async () => {
    const { host, recording } = createHost({ platform: 'linux', arch: 'x64', readPrefix: () => elfHeader().subarray(0, 63) });

    await expect(buildReleaseArtifacts(host)).rejects.toThrow('ELF');

    expect(recording.commands).toEqual([]);
    expect(recording.directories).toEqual([]);
    expect(recording.removed).toEqual([]);
    expect(recording.writes.size).toBe(0);
  });

  test('propagates a header read error without creating an archive or checksum', async () => {
    const refusal = Object.assign(new Error('header access refused'), { code: 'EACCES' });
    const { host, recording } = createHost({ platform: 'linux', arch: 'x64', readPrefix: () => { throw refusal; } });

    await expect(buildReleaseArtifacts(host)).rejects.toBe(refusal);

    expect(recording.commands).toEqual([]);
    expect(recording.directories).toEqual([]);
    expect(recording.removed).toEqual([]);
    expect(recording.writes.size).toBe(0);
  });

  test('a failed GNU tar invocation cleans staging and never publishes a checksum', async () => {
    const { host, recording } = createHost({ platform: 'linux', arch: 'x64' });
    host.run = (command, args) => {
      recording.commands.push({ command, args });
      return { status: 1, stdout: '', stderr: 'archive write failed' };
    };

    await expect(buildReleaseArtifacts(host)).rejects.toThrow('archive write failed');

    expect(recording.commands[0]?.command).toBe('/usr/bin/tar');
    expect(recording.removed.at(-1)).toBe(join(root, 'dist/release/.stage'));
    expect(recording.digests).toEqual([]);
    expect(recording.writes.size).toBe(0);
  });
});

describe('unsupported local archive targets', () => {
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'x64'], ['freebsd', 'x64'],
    ['darwin', 'ia32'], ['linux', 'x86_64'], ['', 'x64']] as const) {
    test(`refuses ${platform || 'missing platform'}/${arch} before any filesystem or process operation`, async () => {
      const { host, recording } = createHost({ platform, arch });

      await expect(buildReleaseArtifacts(host)).rejects.toThrow();

      expect(recording.commands).toEqual([]);
      expect(recording.reads).toEqual([]);
      expect(recording.copies).toEqual([]);
      expect(recording.modes).toEqual([]);
      expect(recording.directories).toEqual([]);
      expect(recording.removed).toEqual([]);
      expect(recording.digests).toEqual([]);
      expect(recording.writes.size).toBe(0);
    });
  }
});

describe('checksum document', () => {
  test('writes sorted two-space SHA-256 lines', () => {
    const document = checksumDocument([
      { name: 'wtm-darwin-x64.tar.gz', sha256: 'b'.repeat(64) },
      { name: 'wtm-darwin-arm64.tar.gz', sha256: 'a'.repeat(64) },
    ]);

    expect(document).toBe(
      `${'a'.repeat(64)}  wtm-darwin-arm64.tar.gz\n${'b'.repeat(64)}  wtm-darwin-x64.tar.gz\n`,
    );
  });

  test('records the produced archive digest in SHA256SUMS', async () => {
    const { host, recording } = createHost();

    await buildReleaseArtifacts(host);

    expect(recording.writes.get(join(root, 'dist/release/SHA256SUMS')))
      .toBe(`${'a'.repeat(64)}  wtm-darwin-arm64.tar.gz\n`);
  });
});
