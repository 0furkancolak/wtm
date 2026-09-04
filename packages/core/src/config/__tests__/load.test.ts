import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceConfig } from '../load';

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

  it('defaults [git] allowed_remote_refs to the origin remote when nothing configures it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const globalConfigPath = join(root, 'absent-global.toml');
    await mkdir(workspaceRoot, { recursive: true });

    const resolved = await resolveWorkspaceConfig({ workspaceRoot, globalConfigPath });

    expect(resolved.value.git?.allowed_remote_refs).toEqual(['refs/remotes/origin/*']);
    expect(resolved.provenance.get('git.allowed_remote_refs')).toEqual({ source: 'built-in' });
  });

  it('lets a workspace wtm.toml replace the default allowed_remote_refs list wholesale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const globalConfigPath = join(root, 'absent-global.toml');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, 'wtm.toml'),
      '[git]\nallowed_remote_refs = ["refs/remotes/upstream/*"]\n',
    );

    const resolved = await resolveWorkspaceConfig({ workspaceRoot, globalConfigPath });

    expect(resolved.value.git?.allowed_remote_refs).toEqual(['refs/remotes/upstream/*']);
    expect(resolved.provenance.get('git.allowed_remote_refs')).toEqual({
      source: join(workspaceRoot, 'wtm.toml'),
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
