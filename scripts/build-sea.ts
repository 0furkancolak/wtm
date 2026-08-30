import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFileNames } from '../packages/core/src/state/assets';
import { seaAssetKeys, seaMigrationAssetKeys, seaSkillAssetKey } from '../packages/cli/src/sea-assets';

export { seaAssetKeys };

/** Standalone V1 pins one Node runtime so every published executable is reproducible. */
export const pinnedNodeVersion = '24.18.0';

/** Node writes this fuse sentinel into every SEA-capable runtime. */
export const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export interface SeaBuildHost {
  root: string;
  arch: string;
  nodeExecutable: string;
  nodeVersion: string;
  bundle(input: { entry: string; outfile: string }): Promise<void>;
  run(command: string, args: readonly string[]): { status: number; stderr: string };
  writeFile(path: string, contents: string): void;
  copyFile(source: string, destination: string): void;
  chmod(path: string, mode: number): void;
  makeDirectory(path: string): void;
  remove(path: string): void;
}

export interface SeaBuildResult {
  executable: string;
  version: string;
  arch: string;
}

export async function buildSea(host: SeaBuildHost): Promise<SeaBuildResult> {
  if (host.nodeVersion !== pinnedNodeVersion) {
    throw new Error(
      `Standalone builds require Node.js ${pinnedNodeVersion}; this host runs ${host.nodeVersion}`,
    );
  }
  const version = packageVersion(host.root);
  const outputDirectory = join(host.root, 'dist/sea');
  const workDirectory = join(outputDirectory, '.build');
  const executable = join(outputDirectory, 'wtm');
  const bundle = join(workDirectory, 'sea-bin.cjs');
  const blob = join(workDirectory, 'wtm.blob');
  const configuration = join(workDirectory, 'sea-config.json');

  host.remove(workDirectory);
  host.makeDirectory(workDirectory);
  try {
    await host.bundle({ entry: join(host.root, 'packages/cli/src/sea-bin.ts'), outfile: bundle });
    host.writeFile(configuration, `${JSON.stringify({
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      assets: seaAssetManifest(host.root),
    }, null, 2)}\n`);
    check(host, host.nodeExecutable, ['--experimental-sea-config', configuration]);

    host.copyFile(host.nodeExecutable, executable);
    host.chmod(executable, 0o755);
    // The published runtime ships unstripped; its debug and local symbols are ~25 MB of dead weight.
    // Stripping comes first: removing the signature leaves link edit information that no longer
    // fills __LINKEDIT, and on x64 `strip` refuses that layout outright. Stripping a still-signed
    // binary only warns that it invalidates the signature, which is what the next line removes.
    check(host, '/usr/bin/strip', ['-x', '-S', executable]);
    // The inherited runtime signature does not cover the injected blob.
    check(host, '/usr/bin/codesign', ['--remove-signature', executable]);
    check(host, host.nodeExecutable, [
      join(host.root, 'node_modules/postject/dist/cli.js'),
      executable,
      'NODE_SEA_BLOB',
      blob,
      '--sentinel-fuse',
      seaFuse,
      '--macho-segment-name',
      'NODE_SEA',
    ]);
    // A stable signing identifier. Without `--identifier`, codesign derives one from the file
    // name and content, so every build signed itself as a different program: macOS records a
    // disk-access grant against the code it was given, and each rebuild asked for it again.
    check(host, '/usr/bin/codesign', ['--sign', '-', '--identifier', signingIdentifier, '--force', executable]);
    check(host, '/usr/bin/codesign', ['--verify', '--strict', executable]);
  } catch (error) {
    host.remove(executable);
    throw error;
  } finally {
    host.remove(workDirectory);
  }
  return { executable, version, arch: host.arch };
}

/** The identity macOS remembers this executable by, across every build of it. */
const signingIdentifier = 'dev.wtm.cli';

export function seaAssetManifest(root: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  seaMigrationAssetKeys.forEach((key, index) => {
    const file = migrationFileNames[index];
    if (file === undefined) throw new Error(`No canonical migration for embedded asset "${key}"`);
    manifest[key] = join(root, 'packages/core/src/state/migrations', file);
  });
  if (Object.keys(manifest).length !== migrationFileNames.length) {
    throw new Error('Embedded migration assets and canonical migrations disagree');
  }
  manifest[seaSkillAssetKey] = join(root, 'skills/wtm/SKILL.md');
  return manifest;
}

export function packageVersion(root: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('package.json declares no version');
  return version;
}

export function createSeaBuildHost(): SeaBuildHost {
  // Bun drives the build tooling, so the pinned Node runtime is resolved explicitly
  // instead of inherited from the tooling process.
  const nodeExecutable = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  return {
    root: resolve(fileURLToPath(import.meta.url), '../..'),
    arch: process.arch,
    nodeExecutable,
    nodeVersion: execFileSync(nodeExecutable, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim(),
    async bundle(input) {
      const built = await Bun.build({
        entrypoints: [input.entry],
        target: 'node',
        format: 'cjs',
        plugins: [nativeSqliteExcluded],
      });
      if (!built.success) throw new AggregateError(built.logs, 'SEA bundling failed');
      const [output] = built.outputs;
      if (output === undefined) throw new Error('SEA bundling produced no output');
      await Bun.write(input.outfile, output);
    },
    run(command, args) {
      const result = spawnSync(command, [...args], { encoding: 'utf8' });
      return { status: result.status ?? 1, stderr: result.stderr ?? '' };
    },
    writeFile(path, contents) { writeFileSync(path, contents, { mode: 0o600 }); },
    copyFile(source, destination) { copyFileSync(source, destination); },
    chmod(path, mode) { chmodSync(path, mode); },
    makeDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); },
    remove(path) { rmSync(path, { recursive: true, force: true }); },
  };
}

/**
 * The standalone variant stores state through `node:sqlite`, so the npm driver's native
 * dependency must never reach the bundle. The stub keeps the shared store source identical
 * across variants while making an accidental native construction a loud failure.
 */
const nativeSqliteExcluded: import('bun').BunPlugin = {
  name: 'wtm-sea-native-sqlite-excluded',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => (
      { path: 'better-sqlite3', namespace: 'wtm-sea-stub' }
    ));
    build.onLoad({ filter: /.*/, namespace: 'wtm-sea-stub' }, () => ({
      contents: 'export default function () {'
        + ' throw new Error("The standalone WTM executable stores state through node:sqlite");'
        + ' }',
      loader: 'js',
    }));
  },
};

function check(host: SeaBuildHost, command: string, args: readonly string[]): void {
  const result = host.run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}: ${result.stderr.trim()}`);
  }
}

if (import.meta.main) {
  const result = await buildSea(createSeaBuildHost());
  process.stdout.write(`${result.executable} (wtm ${result.version}, darwin-${result.arch})\n`);
}
