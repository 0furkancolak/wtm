import type { MigrationAssetProvider } from '../../core/src/state/assets';
import type { SkillAssetProvider } from './assets';

export const seaMigrationAssetKeys = [
  'migration/001',
  'migration/002',
  'migration/003',
  'migration/004',
  'migration/005',
  'migration/006',
  'migration/007',
  'migration/008',
  'migration/009',
] as const;

export const seaSkillAssetKey = 'skill/wtm/SKILL.md';

export const seaAssetKeys = [...seaMigrationAssetKeys, seaSkillAssetKey] as const;

interface SeaRuntime {
  isSea(): boolean;
  getAsset(key: string, encoding: 'utf8'): string;
}

export const seaMigrationAssets: MigrationAssetProvider = {
  readMigrations() {
    return seaMigrationAssetKeys.map((key) => readEmbeddedAsset(key));
  },
};

export const seaSkillAssets: SkillAssetProvider = {
  async readCanonicalSkill() {
    return readEmbeddedAsset(seaSkillAssetKey);
  },
};

export function readEmbeddedAsset(key: string): string {
  const runtime = seaRuntime();
  const asset = runtime.getAsset(key, 'utf8');
  if (asset.length === 0) throw new Error(`The embedded WTM asset "${key}" is empty`);
  return asset;
}

function seaRuntime(): SeaRuntime {
  // Resolved lazily so development runtimes without `node:sea` can still load this module.
  const runtime = process.getBuiltinModule?.('node:sea') as SeaRuntime | undefined;
  if (runtime === undefined || !runtime.isSea()) {
    throw new Error('Embedded WTM assets are only available in the standalone executable');
  }
  return runtime;
}
