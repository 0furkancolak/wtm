import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceConfig } from './load.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('resolveWorkspaceConfig', () => {
  it('loads real TOML files in global, workspace, nested, and repository precedence order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(workspaceRoot, 'apps', 'api');
    const globalConfigPath = join(root, 'global.toml');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(globalConfigPath, '[ports.web]\npreferred = 3000\n');
    await writeFile(join(workspaceRoot, 'wtm.toml'), '[ports.web]\npreferred = 4000\n');
    await writeFile(join(workspaceRoot, 'apps', 'wtm.toml'), '[ports.web]\npreferred = 5000\n');
    await writeFile(join(repoRoot, '.wtm.toml'), '[ports.web]\npreferred = 6000\n');

    const resolved = await resolveWorkspaceConfig({ workspaceRoot, repoRoot, globalConfigPath });

    expect(resolved.value.ports?.web?.preferred).toBe(6000);
    expect(resolved.provenance.get('ports.web.preferred')).toEqual({
      source: join(repoRoot, '.wtm.toml'),
      line: 2,
    });
  });

  it('rejects a task that becomes invalid only after config layers are merged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(workspaceRoot, 'repo');
    const globalConfigPath = join(root, 'global.toml');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(globalConfigPath, '[tasks.dev]\nrun = ["make", "dev"]\n');
    await writeFile(join(repoRoot, '.wtm.toml'), '[tasks.dev]\nmain = ["make", "main"]\n');

    await expect(resolveWorkspaceConfig({ workspaceRoot, repoRoot, globalConfigPath })).rejects.toMatchObject({
      code: 'WTM_CONFIG_INVALID',
      severity: 'error',
    });
  });
});
