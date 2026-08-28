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

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
