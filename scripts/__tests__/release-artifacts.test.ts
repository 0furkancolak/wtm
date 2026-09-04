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
  writes: Map<string, string>;
  copies: Array<{ source: string; destination: string }>;
  modes: Array<{ path: string; mode: number }>;
}

function createHost(overrides: Partial<ReleaseHost> = {}): { host: ReleaseHost; recording: Recording } {
  const recording: Recording = { commands: [], writes: new Map(), copies: [], modes: [] };
  const host: ReleaseHost = {
    root,
    arch: 'arm64',
    run(command, args) {
      recording.commands.push({ command, args });
      return command === '/usr/bin/file'
        ? { status: 0, stdout: `${args.at(-1)}: Mach-O 64-bit executable arm64\n`, stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    },
    digest() { return 'a'.repeat(64); },
    writeFile(path, contents) { recording.writes.set(path, contents); },
    copyFile(source, destination) { recording.copies.push({ source, destination }); },
    chmod(path, mode) { recording.modes.push({ path, mode }); },
    makeDirectory() {},
    remove() {},
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
