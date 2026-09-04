import { describe, expect, it } from 'bun:test';
import type { PreparedResource, Provenance, WtmConfig } from '@wtm/core';
import type { AdapterReport, WorktreeRuntime } from '@wtm/daemon';
import { explainDecisions } from '../decisions';

const provenance = new Map<string, Provenance>([
  ['version', { source: 'built-in' }],
  ['ports.range', { source: '/projects/demo/wtm.toml', line: 8 }],
  ['ports.api.env', { source: '/projects/demo/wtm.toml', line: 12 }],
  ['environment.WTM_ID', { source: '/projects/demo/wtm.toml', line: 20 }],
  ['repos.api.environment.PORT', { source: '/projects/demo/wtm.toml', line: 31 }],
  ['tasks.test.run', { source: '/projects/demo/wtm.toml', line: 44 }],
  ['resources.env.path', { source: '/projects/demo/wtm.toml', line: 50 }],
  ['git.allowed_remote_refs', { source: '/projects/demo/wtm.toml', line: 60 }],
]);

const config: WtmConfig = {
  version: 1,
  ports: { range: '4000-4099', api: { env: 'PORT', preferred: 4000 } },
  environment: { WTM_ID: '{id}' },
  tasks: {
    test: { run: ['make', 'test'] },
    dev: { run: ['make', 'dev'] },
  },
  resources: { env: { path: '.env', policy: 'symlink' } },
  git: { allowed_remote_refs: ['refs/remotes/upstream/*'] },
};

function runtime(): WorktreeRuntime {
  return {
    registration: {
      workspace: {
        id: 'workspace-1', name: 'demo', root: '/projects/demo', scope: 'local',
        configPath: null, createdAt: '', lastSeenAt: '',
      },
      repository: {
        id: 'repository-1', workspaceId: 'workspace-1', commonGitDir: '/projects/demo/api/.git',
        mainRoot: '/projects/demo/api', remoteIdentity: null, createdAt: '', lastReconciledAt: null,
      },
      worktree: {
        id: 'worktree-1', repositoryId: 'repository-1', numericId: 1, path: '/projects/demo/api',
        branch: 'refs/heads/main', headOid: 'head', isMain: true, isLocked: false, state: 'READY',
        createdAt: '', lastSeenAt: '', lastRuntimeAt: null,
      },
    },
    config,
    context: {},
    automaticEnvironment: { PORT: '4000', CORS_ORIGINS: 'http://localhost:4000' },
    repoEnvironment: { PORT: '{port.api}' },
    endpoints: { ports: { api: 4000 }, env: { PORT: '4000' }, origins: ['http://localhost:4000'], leases: [] },
    provenance,
  } as WorktreeRuntime;
}

const adapters: AdapterReport[] = [
  { id: 'make', active: true, provides: ['tasks'], requires: [], tasks: ['dev'], reason: 'Detected in this worktree by Makefile.' },
  { id: 'npm', active: false, provides: ['javascript.package-manager'], requires: [], tasks: [], reason: 'Capability javascript.package-manager has multiple detected providers: npm, pnpm.' },
];

const resources: PreparedResource[] = [
  { name: 'env', path: '/projects/demo/api/.env', policy: 'symlink', state: 'ready' },
];

function explain(environment: Record<string, string> = { PORT: '4000', WTM_ID: '1', CORS_ORIGINS: 'http://localhost:4000' }) {
  return explainDecisions({ runtime: runtime(), adapters, resources, environment });
}

describe('explained decisions', () => {
  it('names the file and line a configuration value came from', () => {
    const decision = explain().find(({ key }) => key === 'ports.range');

    expect(decision).toEqual({
      kind: 'config',
      key: 'ports.range',
      value: '4000-4099',
      provenance: { source: '/projects/demo/wtm.toml', line: 8 },
      reason: 'Declared in /projects/demo/wtm.toml line 8.',
    });
  });

  it('says when a value is WTM\'s own default rather than anybody\'s decision', () => {
    expect(explain().find(({ key }) => key === 'version')?.reason)
      .toBe('WTM\'s own default, because nothing in the configuration says otherwise.');
  });

  it('attributes an environment variable to the layer that actually won it', () => {
    const decisions = explain();

    expect(decisions.find(({ key }) => key === 'env.PORT')).toEqual({
      kind: 'config',
      key: 'env.PORT',
      value: '4000',
      provenance: { source: '/projects/demo/wtm.toml', line: 31 },
      reason: 'Set by this repository\'s own [repos.*.environment], which is layered over the workspace\'s.',
    });
    expect(decisions.find(({ key }) => key === 'env.WTM_ID')?.provenance)
      .toEqual({ source: '/projects/demo/wtm.toml', line: 20 });
  });

  it('explains a variable no file declares by the endpoint that published it', () => {
    const { repoEnvironment: _repoEnvironment, ...withoutRepoLayer } = runtime();
    const decisions = explainDecisions({
      runtime: withoutRepoLayer as WorktreeRuntime,
      adapters,
      resources,
      environment: { PORT: '4000' },
    });

    expect(decisions.find(({ key }) => key === 'env.PORT')?.reason)
      .toBe('The port leased for [ports.api], published under the name that table asks for.');
  });

  it('says which adapter is in force and why the other one is not', () => {
    const decisions = explain().filter(({ kind }) => kind === 'adapter');

    expect(decisions.map(({ key, reason }) => [key, reason])).toEqual([
      ['make', 'Detected in this worktree by Makefile.'],
      ['npm', 'Capability javascript.package-manager has multiple detected providers: npm, pnpm.'],
    ]);
  });

  it('distinguishes a task the configuration defines from one an adapter contributes', () => {
    const decisions = explain().filter(({ kind }) => kind === 'task');

    expect(decisions.find(({ key }) => key === 'test')?.provenance)
      .toEqual({ source: '/projects/demo/wtm.toml', line: 44 });
    expect(decisions.find(({ key }) => key === 'dev')).toEqual({
      kind: 'task',
      key: 'dev',
      value: { run: ['make', 'dev'] },
      provenance: { source: 'adapter:make' },
      reason: 'Contributed by the make adapter, because the configuration does not define it.',
    });
  });

  it('reports each declared resource with the state this worktree has it in', () => {
    expect(explain().find(({ kind }) => kind === 'resource')).toEqual({
      kind: 'resource',
      key: 'env',
      value: { path: '/projects/demo/api/.env', policy: 'symlink', state: 'ready' },
      provenance: { source: '/projects/demo/wtm.toml', line: 50 },
      reason: 'Declared by [resources], and in place.',
    });
  });

  it('surfaces the configured [git] allowed_remote_refs as a config decision, for `wtm explain`', () => {
    const decision = explain().find(({ key }) => key === 'git.allowed_remote_refs');

    expect(decision).toEqual({
      kind: 'config',
      key: 'git.allowed_remote_refs',
      value: ['refs/remotes/upstream/*'],
      provenance: { source: '/projects/demo/wtm.toml', line: 60 },
      reason: 'Declared in /projects/demo/wtm.toml line 60.',
    });
  });

  it('leaves task and resource tables out of the per-leaf configuration list', () => {
    const keys = explain().filter(({ kind }) => kind === 'config').map(({ key }) => key);

    expect(keys.filter((key) => key.startsWith('tasks.'))).toEqual([]);
    expect(keys.filter((key) => key.startsWith('resources.'))).toEqual([]);
  });
});
