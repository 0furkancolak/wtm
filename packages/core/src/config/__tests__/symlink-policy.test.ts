import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWtmConfig } from '../schema';
import { resolveWorkspaceConfig } from '../load';

test('untracked symlink policy accepts only the three explicit values', () => {
  for (const value of ['ignore', 'review', 'block'] as const) {
    expect(parseWtmConfig({ safety: { untracked_symlinks: value } })).toEqual({ safety: { untracked_symlinks: value } });
  }
  for (const value of ['', 'force', 'BLOCK', true, null]) {
    expect(() => parseWtmConfig({ safety: { untracked_symlinks: value } })).toThrow();
  }
  expect(() => parseWtmConfig({ safety: { ignored_symlinks: 'ignore' } })).toThrow();
});

test('symlink policy preserves defaults and each configuration layer with provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtm-symlink-config-'));
  const workspaceRoot = join(root, 'workspace');
  const repoRoot = join(workspaceRoot, 'apps', 'repo');
  const globalConfigPath = join(root, 'global.toml');
  const key = 'safety.untracked_symlinks';
  try {
    await mkdir(repoRoot, { recursive: true });
    const load = () => resolveWorkspaceConfig({ workspaceRoot, repoRoot, globalConfigPath });
    let resolved = await load();
    expect(resolved.value.safety?.untracked_symlinks).toBe('ignore');
    expect(resolved.provenance.get(key)).toEqual({ source: 'built-in' });
    for (const [path, policy] of [
      [globalConfigPath, 'block'],
      [join(workspaceRoot, 'wtm.toml'), 'review'],
      [join(workspaceRoot, 'apps', 'wtm.toml'), 'block'],
      [join(repoRoot, '.wtm.toml'), 'ignore'],
    ] as const) {
      await writeFile(path, `[safety]\nuntracked_symlinks = "${policy}"\n`);
      resolved = await load();
      expect(resolved.value.safety?.untracked_symlinks).toBe(policy);
      expect(resolved.provenance.get(key)).toEqual({ source: path, line: 2 });
    }
    // An absent leaf in the final layer must not install a schema default over its parent.
    await writeFile(join(repoRoot, '.wtm.toml'), '[safety]\n');
    expect((await load()).value.safety?.untracked_symlinks).toBe('block');
  } finally { await rm(root, { recursive: true, force: true }); }
});
