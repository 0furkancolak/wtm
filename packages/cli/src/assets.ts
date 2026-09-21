import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillAssetProvider {
  readCanonicalSkill(): Promise<string>;
}

export const filesystemSkillAssets: SkillAssetProvider = {
  async readCanonicalSkill() {
    const path = canonicalSkillPathForModule(import.meta.url);
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw new Error('The canonical WTM Agent Skill is missing from this installation.');
    }
  },
};

let installedSkillAssets: SkillAssetProvider | null = null;

/**
 * Selects the skill asset provider for callers without explicit options. A packaged
 * entrypoint installs its provider once, before any command runs.
 */
export function installSkillAssets(provider: SkillAssetProvider): void {
  if (installedSkillAssets !== null) throw new Error('The WTM skill asset provider is already installed');
  installedSkillAssets = provider;
}

export function skillAssets(): SkillAssetProvider {
  return installedSkillAssets ?? filesystemSkillAssets;
}

export function canonicalSkillPathForModule(moduleUrl: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const sourceDirectory = dirname(moduleDirectory);
  const cliDirectory = dirname(sourceDirectory);
  const packagesDirectory = dirname(cliDirectory);
  if (basename(moduleDirectory) === 'commands' && basename(sourceDirectory) === 'src'
    && basename(cliDirectory) === 'cli' && basename(packagesDirectory) === 'packages') {
    return resolve(packagesDirectory, '..', 'skills', 'wtm', 'SKILL.md');
  }
  if (basename(moduleDirectory) === 'src' && basename(sourceDirectory) === 'cli'
    && basename(cliDirectory) === 'packages') {
    return resolve(cliDirectory, '..', 'skills', 'wtm', 'SKILL.md');
  }
  if (basename(moduleDirectory) === 'cli' && basename(dirname(moduleDirectory)) === 'dist') {
    return join(moduleDirectory, 'skills', 'wtm', 'SKILL.md');
  }
  throw new Error('The WTM Agent Skill runtime layout is unsupported.');
}

/**
 * The fixed, known set `wtm init --preset <name>` accepts — one name per `examples/<name>/wtm.toml`
 * this repository ships. Deliberately not a registry: widening this list means adding both a name
 * here and its example file, nothing more.
 */
export const presetNames = [
  'nextjs', 'nextjs-hono', 'bun-monorepo', 'docker-compose', 'python-uv', 'rust', 'go',
] as const;

export type PresetName = typeof presetNames[number];

export function isPresetName(value: string): value is PresetName {
  return (presetNames as readonly string[]).includes(value);
}

export interface PresetAssetProvider {
  readPreset(name: PresetName): Promise<string>;
}

export const filesystemPresetAssets: PresetAssetProvider = {
  async readPreset(name) {
    const path = presetPathForModule(import.meta.url, name);
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      throw new Error(`The "${name}" preset is missing from this installation.`);
    }
  },
};

let installedPresetAssets: PresetAssetProvider | null = null;

/**
 * Selects the preset asset provider for callers without explicit options. A packaged entrypoint
 * installs its provider once, before any command runs — see `installSkillAssets` above, which
 * this mirrors. Nothing installs one today: presets are read straight off the development and
 * npm-packaged filesystem layout (`presetPathForModule`'s first two branches); the standalone
 * executable does not yet embed them the way it embeds the Agent Skill and migrations, so
 * `wtm init --preset` in that build reports the preset as missing rather than seeding one. Wiring
 * a `sea/*` provider the way `seaSkillAssets` does is unclaimed follow-up work, not part of this
 * change.
 */
export function installPresetAssets(provider: PresetAssetProvider): void {
  if (installedPresetAssets !== null) throw new Error('The WTM preset asset provider is already installed');
  installedPresetAssets = provider;
}

export function presetAssets(): PresetAssetProvider {
  return installedPresetAssets ?? filesystemPresetAssets;
}

export function presetPathForModule(moduleUrl: string, name: PresetName): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const sourceDirectory = dirname(moduleDirectory);
  const cliDirectory = dirname(sourceDirectory);
  const packagesDirectory = dirname(cliDirectory);
  if (basename(moduleDirectory) === 'commands' && basename(sourceDirectory) === 'src'
    && basename(cliDirectory) === 'cli' && basename(packagesDirectory) === 'packages') {
    return resolve(packagesDirectory, '..', 'examples', name, 'wtm.toml');
  }
  if (basename(moduleDirectory) === 'src' && basename(sourceDirectory) === 'cli'
    && basename(cliDirectory) === 'packages') {
    return resolve(cliDirectory, '..', 'examples', name, 'wtm.toml');
  }
  if (basename(moduleDirectory) === 'cli' && basename(dirname(moduleDirectory)) === 'dist') {
    return join(moduleDirectory, 'examples', name, 'wtm.toml');
  }
  throw new Error('The WTM preset runtime layout is unsupported.');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
