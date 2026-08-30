import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManagedProcessRecord, PreparedResource, WtmConfig } from '@wtm/core';
import type { AdapterReport, WorktreeRuntime } from '@wtm/daemon';
import { planChanges } from '../changes';

function runtime(root: string, config: WtmConfig, observed: WorktreeRuntime['observedEndpoints']): WorktreeRuntime {
  return {
    registration: {
      workspace: {
        id: 'workspace-1', name: 'demo', root, scope: 'local',
        configPath: null, createdAt: '', lastSeenAt: '',
      },
      repository: {
        id: 'repository-1', workspaceId: 'workspace-1', commonGitDir: join(root, 'api/.git'),
        mainRoot: join(root, 'api'), remoteIdentity: null, createdAt: '', lastReconciledAt: null,
      },
      worktree: {
        id: 'worktree-1', repositoryId: 'repository-1', numericId: 1, path: join(root, 'api'),
        branch: 'refs/heads/main', headOid: 'head', isMain: true, isLocked: false, state: 'READY',
        createdAt: '', lastSeenAt: '', lastRuntimeAt: null,
      },
    },
    config,
    context: {},
    automaticEnvironment: {},
    endpoints: { ports: {}, env: {}, origins: [], leases: [] },
    provenance: new Map(),
    observedEndpoints: observed,
  } as WorktreeRuntime;
}

function record(taskName: string, pid: number): ManagedProcessRecord {
  return {
    id: `process-${taskName}`,
    worktreeId: 'worktree-1',
    taskName,
    pid,
    pgid: pid,
    state: 'RUNNING',
    startedAt: '2026-01-01T00:00:00.000Z',
    stoppedAt: null,
  } as ManagedProcessRecord;
}

async function plan(options: {
  config?: WtmConfig;
  observed?: WorktreeRuntime['observedEndpoints'];
  resources?: PreparedResource[];
  processes?: Array<{ record: ManagedProcessRecord; alive: boolean }>;
  adapters?: AdapterReport[];
  /** A repository that declares a port, so the detection half of the plan has something to say. */
  declaring?: boolean;
  /** What the workspace's own `wtm.toml` already says, written to disk as the draft reads it. */
  toml?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wtm-plan-'));
  try {
    const repositoryRoots: string[] = [];
    if (options.declaring === true) {
      mkdirSync(join(root, 'api'), { recursive: true });
      writeFileSync(join(root, 'api/.env.example'), 'PORT=4000\nCORS_ORIGINS=\n');
      repositoryRoots.push(join(root, 'api'));
    }
    if (options.toml !== undefined) writeFileSync(join(root, 'wtm.toml'), options.toml);
    return await planChanges({
      runtime: runtime(root, options.config ?? {}, options.observed ?? []),
      adapters: options.adapters ?? [],
      resources: options.resources ?? [],
      processes: options.processes ?? [],
      repositoryRoots,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('planned changes', () => {
  it('says which endpoints would take a port and which already hold one', async () => {
    const changes = await plan({
      observed: [
        { name: 'api', port: null, fixed: false },
        { name: 'web', port: 4001, fixed: false },
        { name: 'db', port: 5432, fixed: true },
      ],
    });

    expect(changes.filter(({ kind }) => kind === 'endpoint').map(({ target, action }) => [target, action]))
      .toEqual([['api', 'create'], ['web', 'none'], ['db', 'none']]);
    expect(changes.find(({ target }) => target === 'api')?.reason)
      .toBe('No port is leased for this feature yet; the next task to run here would take one.');
    expect(changes.find(({ target }) => target === 'db')?.reason)
      .toBe('Fixed at 5432 by the configuration, so nothing is leased.');
  });

  it('proposes creating a declared resource that is not there', async () => {
    const changes = await plan({
      resources: [
        { name: 'env', path: '/w/.env', policy: 'symlink', state: 'missing' },
        { name: 'cache', path: '/w/.cache', policy: 'isolated', state: 'ready' },
      ],
    });

    expect(changes.filter(({ kind }) => kind === 'resource').map(({ target, action }) => [target, action]))
      .toEqual([['env', 'create'], ['cache', 'none']]);
  });

  it('carries the obstacle forward when a resource could not be created', async () => {
    const changes = await plan({
      resources: [{
        name: 'env', path: '/w/.env', policy: 'symlink', state: 'degraded',
        detail: 'Its source is not there.',
      }],
    });

    expect(changes[0]?.reason).toBe('Its source is not there. The next task here will try again.');
  });

  it('proposes retiring a record that says RUNNING for a process that is gone', async () => {
    const changes = await plan({
      processes: [
        { record: record('dev', 4242), alive: false },
        { record: record('api', 4243), alive: true },
      ],
    });

    expect(changes.filter(({ kind }) => kind === 'process').map(({ target, action }) => [target, action]))
      .toEqual([['dev', 'remove'], ['api', 'none']]);
  });

  it('reports only the adapters that recognized the worktree and were left out', async () => {
    const changes = await plan({
      adapters: [
        { id: 'make', active: true, provides: [], requires: [], tasks: ['dev'], reason: 'Detected.' },
        { id: 'npm', active: false, provides: [], requires: [], tasks: [], reason: 'Two providers.' },
      ],
    });

    expect(changes.filter(({ kind }) => kind === 'adapter'))
      .toEqual([{ kind: 'adapter', action: 'none', target: 'npm', reason: 'Two providers.' }]);
  });

  it('proposes the tables detection would add, with the TOML that says them', async () => {
    const changes = (await plan({ declaring: true })).filter(({ kind }) => kind === 'config');

    expect(changes.map(({ target, action }) => [target, action]))
      .toEqual([['ports', 'create'], ['ports.api', 'create'], ['repos.api', 'create'], ['cors', 'create']]);
    expect(changes[1]?.details?.['toml']).toContain('[ports.api]');
    expect(changes[0]?.reason).toContain('wtm detect --write');
  });

  it('leaves alone the tables the workspace has already decided for itself', async () => {
    const changes = await plan({
      declaring: true,
      toml: 'version = 1\n\n[ports]\nrange = "4000-4099"\n\n[ports.api]\npreferred = 4000\n',
    });

    expect(changes.filter(({ kind }) => kind === 'config').map(({ target }) => target))
      .toEqual(['repos.api', 'cors']);
  });
});
