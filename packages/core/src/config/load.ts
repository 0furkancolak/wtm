import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { defaultAllowedRemoteRefs } from '../analysis/remote-persistence';
import { mergeConfigLayers, type ConfigLayer } from './merge';
import { collectProvenance, type ResolvedConfig } from './provenance';
import { parseWtmConfig, WtmConfigError, type WtmConfig } from './schema';

export const builtInConfig: WtmConfig = {
  version: 1,
  discovery: { repos: true, worktrees: true, max_depth: 5 },
  prepare: { mode: 'lazy' },
  ports: { strategy: 'stable-dynamic', range: '20000-50000' },
  // The same default `analyzeRemotePersistence` falls back to when nothing configures it, named
  // here instead of left implicit so `wtm explain` has a "WTM's own default" to report and a
  // `[git]` override in `wtm.toml` has a documented value to replace.
  git: { allowed_remote_refs: [...defaultAllowedRemoteRefs] },
};

async function loadConfigFile(path: string): Promise<ConfigLayer | undefined> {
  let toml: string;
  try {
    toml = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  try {
    const value = parseWtmConfig(parse(toml), path);
    return { source: path, value, provenance: collectProvenance(value, path, toml) };
  } catch (error) {
    if (error instanceof WtmConfigError) throw error;
    throw new WtmConfigError('WTM configuration is invalid TOML.', { source: path, cause: error instanceof Error ? error.message : String(error) });
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function nestedConfigPaths(workspaceRoot: string, repoRoot: string): string[] {
  const workspace = resolve(workspaceRoot);
  const repository = resolve(repoRoot);
  const relativeRepo = relative(workspace, repository);
  if (relativeRepo === '' || relativeRepo === '..' || relativeRepo.startsWith(`..${sep}`) || relativeRepo.split(sep).some((part) => part === '..')) {
    return [];
  }

  const parts = relativeRepo.split(sep).filter(Boolean);
  const paths: string[] = [];
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    paths.push(join(current, 'wtm.toml'));
  }
  return paths;
}

export async function resolveWorkspaceConfig(input: {
  workspaceRoot: string;
  repoRoot?: string;
  globalConfigPath: string;
}): Promise<ResolvedConfig<WtmConfig>> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const repoRoot = input.repoRoot === undefined ? undefined : resolve(input.repoRoot);
  const paths = [
    input.globalConfigPath,
    join(workspaceRoot, 'wtm.toml'),
    ...(repoRoot === undefined ? [] : nestedConfigPaths(workspaceRoot, repoRoot)),
    ...(repoRoot === undefined ? [] : [join(repoRoot, '.wtm.toml')]),
  ];
  const loaded = await Promise.all(paths.map(loadConfigFile));
  const merged = mergeConfigLayers([
    { source: 'built-in', value: builtInConfig },
    ...loaded.filter((layer): layer is ConfigLayer => layer !== undefined),
  ]);
  return { value: parseWtmConfig(merged.value), provenance: merged.provenance };
}
