import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSea, pinnedNodeVersion, seaAssetKeys, type SeaBuildHost } from '../build-sea';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

interface Recording {
  bundles: Array<{ entry: string; outfile: string }>;
  commands: Array<{ command: string; args: readonly string[] }>;
  writes: Map<string, string>;
  copies: Array<{ source: string; destination: string }>;
  modes: Array<{ path: string; mode: number }>;
  removed: string[];
}

function createHost(overrides: Partial<SeaBuildHost> = {}): { host: SeaBuildHost; recording: Recording } {
  const recording: Recording = {
    bundles: [], commands: [], writes: new Map(), copies: [], modes: [], removed: [],
  };
  const host: SeaBuildHost = {
    root,
    arch: 'arm64',
    nodeExecutable: '/opt/node-24.18.0/bin/node',
    nodeVersion: pinnedNodeVersion,
    async bundle(input) { recording.bundles.push(input); },
    run(command, args) { recording.commands.push({ command, args }); return { status: 0, stderr: '' }; },
    writeFile(path, contents) { recording.writes.set(path, contents); },
    copyFile(source, destination) { recording.copies.push({ source, destination }); },
    chmod(path, mode) { recording.modes.push({ path, mode }); },
    makeDirectory() {},
    remove(path) { recording.removed.push(path); },
    ...overrides,
  };
  return { host, recording };
}

function configurationOf(recording: Recording): Record<string, unknown> {
  const entry = [...recording.writes].find(([path]) => path.endsWith('sea-config.json'));
  if (entry === undefined) throw new Error(`no SEA configuration written: ${[...recording.writes.keys()].join(', ')}`);
  return JSON.parse(entry[1]);
}

describe('SEA configuration', () => {
  test('declares exactly the supported Node SEA keys', async () => {
    const { host, recording } = createHost();

    await buildSea(host);

    const configuration = configurationOf(recording);
    expect(Object.keys(configuration).sort())
      .toEqual(['assets', 'disableExperimentalSEAWarning', 'main', 'output']);
    expect(configuration.disableExperimentalSEAWarning).toBe(true);
    expect(configuration.main).toMatch(/sea-bin\.cjs$/);
    expect(configuration.output).toMatch(/\.blob$/);
  });

  test('embeds the nine ordered migrations and the canonical skill from their repository sources', async () => {
    const { host, recording } = createHost();

    await buildSea(host);

    const assets = configurationOf(recording).assets as Record<string, string>;
    expect(Object.keys(assets)).toEqual([...seaAssetKeys]);
    expect(seaAssetKeys).toEqual([
      'migration/001', 'migration/002', 'migration/003', 'migration/004',
      'migration/005', 'migration/006', 'migration/007', 'migration/008',
      'migration/009',
      'skill/wtm/SKILL.md',
    ]);
    for (const path of Object.values(assets)) expect(existsSync(path)).toBe(true);
    expect(assets['migration/001']).toBe(join(root, 'packages/core/src/state/migrations/001-initial.sql'));
    expect(assets['skill/wtm/SKILL.md']).toBe(join(root, 'skills/wtm/SKILL.md'));
  });

  test('bundles the SEA bootstrap as a single CommonJS script', async () => {
    const { host, recording } = createHost();

    const result = await buildSea(host);

    expect(recording.bundles).toEqual([{
      entry: join(root, 'packages/cli/src/sea-bin.ts'),
      outfile: join(root, 'dist/sea/.build/sea-bin.cjs'),
    }]);
    expect(result.version).toBe(packageVersion);
    expect(result.executable).toBe(join(root, 'dist/sea/wtm'));
  });
});

describe('SEA executable assembly', () => {
  test('refuses to build on a host that is not the pinned Node runtime', async () => {
    const { host } = createHost({ nodeVersion: '24.17.0' });

    await expect(buildSea(host)).rejects.toThrow(pinnedNodeVersion);
  });

  test('generates the blob, copies the runtime, and injects it with the documented postject arguments', async () => {
    const { host, recording } = createHost();

    const result = await buildSea(host);

    const blob = join(root, 'dist/sea/.build/wtm.blob');
    expect(recording.commands[0]).toEqual({
      command: host.nodeExecutable,
      args: ['--experimental-sea-config', join(root, 'dist/sea/.build/sea-config.json')],
    });
    expect(recording.copies).toEqual([{ source: host.nodeExecutable, destination: result.executable }]);
    expect(recording.commands).toContainEqual({
      command: host.nodeExecutable,
      args: [
        join(root, 'node_modules/postject/dist/cli.js'),
        result.executable,
        'NODE_SEA_BLOB',
        blob,
        '--sentinel-fuse',
        'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
        '--macho-segment-name',
        'NODE_SEA',
      ],
    });
  });

  test('strips the copied runtime between signature removal and injection', async () => {
    const { host, recording } = createHost();

    const result = await buildSea(host);

    const indexOf = (match: (entry: { command: string; args: readonly string[] }) => boolean) =>
      recording.commands.findIndex(match);
    const stripped = indexOf(({ command }) => command === '/usr/bin/strip');
    expect(recording.commands[stripped])
      .toEqual({ command: '/usr/bin/strip', args: ['-x', '-S', result.executable] });
    expect(indexOf(({ args }) => args[0] === '--remove-signature')).toBeLessThan(stripped);
    expect(stripped).toBeLessThan(indexOf(({ args }) => args[0]?.endsWith('postject/dist/cli.js') === true));
  });

  test('re-signs under one identifier, so macOS knows every build as the same program', async () => {
    const { host, recording } = createHost();

    const result = await buildSea(host);

    const codesign = recording.commands.filter(({ command }) => command === '/usr/bin/codesign');
    expect(codesign.map(({ args }) => args)).toEqual([
      ['--remove-signature', result.executable],
      // Without an explicit identifier codesign derives one from the file name and content,
      // and every build signs itself as a different program — so every build has to ask the
      // user for disk access again.
      ['--sign', '-', '--identifier', 'dev.wtm.cli', '--force', result.executable],
      ['--verify', '--strict', result.executable],
    ]);
    expect(recording.modes).toEqual([{ path: result.executable, mode: 0o755 }]);
  });

  test('aborts and removes partial output when stripping fails', async () => {
    const { host, recording } = createHost({
      run(command, args) {
        recording.commands.push({ command, args });
        return command === '/usr/bin/strip'
          ? { status: 1, stderr: 'strip: bad' }
          : { status: 0, stderr: '' };
      },
    });

    await expect(buildSea(host)).rejects.toThrow('strip: bad');
    expect(recording.removed).toContain(join(root, 'dist/sea/.build'));
    expect(recording.removed).toContain(join(root, 'dist/sea/wtm'));
  });

  test('reports the failing command and removes scratch and partial output', async () => {
    const { host, recording } = createHost({
      run(command, args) {
        recording.commands.push({ command, args });
        return args[0] === '--remove-signature'
          ? { status: 1, stderr: 'codesign: bad' }
          : { status: 0, stderr: '' };
      },
    });

    await expect(buildSea(host)).rejects.toThrow('codesign: bad');
    expect(recording.removed).toContain(join(root, 'dist/sea/.build'));
    expect(recording.removed).toContain(join(root, 'dist/sea/wtm'));
  });
});
