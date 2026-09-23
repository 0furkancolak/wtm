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

  it('accepts a task whose fields only satisfy a cross-field rule once merged across layers', async () => {
    // `queue_env` requires `queue = true` -- a real rule, but one that used to be checked against
    // each config file in isolation instead of the merged result. A workspace enabling the queue
    // and a repository adding queue_env on top of it is exactly the layering split/override
    // model this whole loader exists for, and it used to be rejected while loading the repo's own
    // `.wtm.toml` alone, even though the merged task is completely valid.
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const repoRoot = join(workspaceRoot, 'repo');
    const globalConfigPath = join(root, 'global.toml');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      join(workspaceRoot, 'wtm.toml'),
      '[tasks.build]\nqueue = true\nrun = ["make", "build"]\ntimeout = "10m"\n',
    );
    await writeFile(join(repoRoot, '.wtm.toml'), '[tasks.build]\nqueue_env = { FOO = "1" }\n');

    const resolved = await resolveWorkspaceConfig({ workspaceRoot, repoRoot, globalConfigPath });

    expect(resolved.value.tasks?.build).toMatchObject({
      queue: true,
      queue_env: { FOO: '1' },
      run: ['make', 'build'],
      timeout: '10m',
    });
  });

  it('still rejects a merged task that violates a cross-field rule no layer alone fixes', async () => {
    // The lenient per-layer parse must not swallow a real error -- only defer cross-field checks
    // to the merged result, not drop them. `queue_env` with no `queue = true` anywhere in any
    // layer is invalid however it is assembled.
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const globalConfigPath = join(root, 'absent-global.toml');
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, 'wtm.toml'), '[tasks.build]\nqueue_env = { FOO = "1" }\n');

    await expect(resolveWorkspaceConfig({ workspaceRoot, globalConfigPath })).rejects.toMatchObject({
      code: 'WTM_CONFIG_INVALID',
      severity: 'error',
    });
  });

  it('still catches a plain field-type error in one layer, with that layer named as the source', async () => {
    // The per-layer parse only skips *cross-field* rules; ordinary shape errors (wrong type, bad
    // enum) are still real regardless of any other layer, and reporting them against the file
    // that actually has the typo is strictly more useful than only catching it after merging.
    const root = await mkdtemp(join(tmpdir(), 'wtm-config-'));
    directories.push(root);
    const workspaceRoot = join(root, 'workspace');
    const globalConfigPath = join(root, 'absent-global.toml');
    await mkdir(workspaceRoot, { recursive: true });
    const workspaceConfigPath = join(workspaceRoot, 'wtm.toml');
    await writeFile(workspaceConfigPath, '[ports.web]\npreferred = "not-a-number"\n');

    await expect(resolveWorkspaceConfig({ workspaceRoot, globalConfigPath })).rejects.toMatchObject({
      code: 'WTM_CONFIG_INVALID',
      severity: 'error',
      context: { source: workspaceConfigPath },
    });
  });
});
