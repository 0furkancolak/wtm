import { describe, expect, it } from 'bun:test';
import type { ReconcileResult, RepositoryRecord, WorktreeRecord, WtmConfig } from '@wtm/core';
import { LifecycleEventDispatcher } from '../events';
import type { ManagedProcessStartInput } from '../process-supervisor';
import type { WorktreeRuntime } from '../task-resolution';

const worktree: WorktreeRecord = {
  id: 'worktree-1',
  repositoryId: 'repository-1',
  numericId: 1,
  path: '/projects/demo/repo',
  branch: 'refs/heads/main',
  headOid: 'head',
  isMain: true,
  isLocked: false,
  state: 'READY',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  lastRuntimeAt: null,
};

const repository: RepositoryRecord = {
  id: 'repository-1',
  workspaceId: 'workspace-1',
  commonGitDir: '/projects/demo/repo/.git',
  mainRoot: '/projects/demo/repo',
  remoteIdentity: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastReconciledAt: '2026-01-01T00:00:00.000Z',
};

function runtimeWith(config: WtmConfig): WorktreeRuntime {
  return {
    registration: {
      workspace: {
        id: 'workspace-1', name: 'demo', root: '/projects/demo', scope: 'local',
        configPath: null, createdAt: '', lastSeenAt: '',
      },
      repository,
      worktree,
    },
    config,
    context: {
      workspace: { root: '/projects/demo', name: 'demo' },
      repo: { root: worktree.path, name: 'repo' },
      main: { root: repository.mainRoot },
      worktree: { root: worktree.path },
      id: 1, key: '1', slug: 'repo', branch: 'main', branchSlug: 'main',
      ports: {}, cors: { origins: '' }, env: {},
    },
    automaticEnvironment: {},
    endpoints: { ports: {}, env: {}, origins: [], leases: [] },
    provenance: new Map(),
  } as WorktreeRuntime;
}

interface Harness {
  dispatcher: LifecycleEventDispatcher;
  started: ManagedProcessStartInput[];
  errors: unknown[];
  claims: string[];
}

function createHarness(config: WtmConfig, options: {
  claimed?: Set<string>;
  worktrees?: WorktreeRecord[];
  failStart?: boolean;
  failRuntime?: boolean;
} = {}): Harness & { allocations: boolean[] } {
  const claimed = options.claimed ?? new Set<string>();
  const claims: string[] = [];
  const started: ManagedProcessStartInput[] = [];
  const errors: unknown[] = [];
  const allocations: boolean[] = [];
  const store = {
    listWorktrees: () => options.worktrees ?? [worktree],
    claimLifecycleEvent: (type: string, id: string, event: string) => {
      const key = `${type}:${id}:${event}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      claims.push(key);
      return true;
    },
    releaseLifecycleEvent: (type: string, id: string, event: string) => {
      const key = `${type}:${id}:${event}`;
      claims.splice(claims.indexOf(key), 1);
      return claimed.delete(key);
    },
  };
  const dispatcher = new LifecycleEventDispatcher({
    store: store as never,
    globalConfigPath: '/config.toml',
    start: async (input) => {
      if (options.failStart === true) throw new Error('spawn refused');
      started.push(input);
    },
    onError: (error) => { errors.push(error); },
    runtimeFor: async (_path, allocate) => {
      allocations.push(allocate);
      if (options.failRuntime === true) throw new Error('configuration does not resolve');
      return runtimeWith(config);
    },
  });
  return { dispatcher, started, errors, claims, allocations };
}

const installTask: WtmConfig = {
  tasks: { 'deps.install': { run: ['make', 'deps'], cwd: '/projects/demo' } },
  events: { 'worktree.created': { tasks: ['deps.install'] } },
};

describe('lifecycle event dispatch', () => {
  it('runs the tasks a workspace attached to an event', async () => {
    const harness = createHarness(installTask);

    const result = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(result.announced).toBe(true);
    expect(result.tasks).toEqual([{ task: 'deps.install', started: true }]);
    expect(harness.started.map(({ taskName, argv }) => [taskName, argv]))
      .toEqual([['deps.install', ['make', 'deps']]]);
  });

  it('announces a once-only event once, so a restart does not install again', async () => {
    const harness = createHarness(installTask);

    await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });
    const second = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(second.announced).toBe(false);
    expect(second.tasks).toEqual([]);
    expect(harness.started).toHaveLength(1);
  });

  it('runs a repeatable event every time it happens', async () => {
    const harness = createHarness({
      tasks: { notify: { run: ['true'], cwd: '/projects/demo' } },
      events: { 'runtime.stopped': { tasks: ['notify'] } },
    });

    await harness.dispatcher.dispatchForWorktree('runtime.stopped', worktree.id);
    await harness.dispatcher.dispatchForWorktree('runtime.stopped', worktree.id);

    expect(harness.started).toHaveLength(2);
    expect(harness.claims).toEqual([]);
  });

  it('withdraws its announcement when it could not dispatch at all', async () => {
    // A configuration that does not resolve today usually resolves once it is fixed, and a
    // claim spent on a dispatch that never happened would mean the event never fires.
    const harness = createHarness(installTask, { failRuntime: true });

    const first = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(first.announced).toBe(false);
    expect(harness.claims).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  it('keeps its announcement when the event ran and the task itself failed', async () => {
    const harness = createHarness(installTask, { failStart: true });

    await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });
    const again = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(harness.claims).toEqual(['worktree:worktree-1:worktree.created']);
    expect(again.announced).toBe(false);
  });

  it('reports a task that will not start without failing the event', async () => {
    const harness = createHarness(installTask, { failStart: true });

    const result = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(result.tasks).toEqual([{ task: 'deps.install', started: false, error: 'spawn refused' }]);
    expect(harness.errors).toHaveLength(1);
    expect((harness.errors[0] as Error).message)
      .toBe('[events."worktree.created"] task deps.install did not start: spawn refused');
  });

  it('reports a task the configuration does not define, and keeps going', async () => {
    const harness = createHarness({
      tasks: { present: { run: ['true'], cwd: '/projects/demo' } },
      events: { 'worktree.created': { tasks: ['absent', 'present'] } },
    });

    const result = await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(result.tasks.map(({ task, started }) => [task, started]))
      .toEqual([['absent', false], ['present', true]]);
  });

  it('does nothing for an event no configuration mentions', async () => {
    const harness = createHarness({ tasks: {} });

    const result = await harness.dispatcher.dispatch({ event: 'worktree.removed', worktree });

    expect(result.tasks).toEqual([]);
    expect(harness.started).toEqual([]);
  });

  it('leases nothing to find out that an event has nothing attached', async () => {
    // Every newly discovered worktree passes through here, and `lazy` promises that a worktree
    // nobody has run anything in costs nothing.
    const harness = createHarness({ tasks: {} });

    await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(harness.allocations).toEqual([false]);
  });

  it('resolves for real once there is a task to run', async () => {
    const harness = createHarness(installTask);

    await harness.dispatcher.dispatch({ event: 'worktree.created', worktree });

    expect(harness.allocations).toEqual([false, true]);
  });

  it('reads which prepare mode is in force without leasing anything', async () => {
    const harness = createHarness({ prepare: { mode: 'lazy' }, tasks: {} });

    await harness.dispatcher.prepareDiscovered(worktree);

    expect(harness.allocations).toEqual([false]);
  });

  it('calls a worktree WTM has just learned of created, once the repository is known', async () => {
    const harness = createHarness(installTask);

    await harness.dispatcher.onReconciled(repository, reconciled({ discovered: [worktree] }));

    expect(harness.claims).toContain('worktree:worktree-1:worktree.created');
    expect(harness.claims).not.toContain('worktree:worktree-1:worktree.discovered');
  });

  it('calls a worktree found on a repository\'s first reconcile discovered', async () => {
    const harness = createHarness(installTask);

    await harness.dispatcher.onReconciled(
      { ...repository, lastReconciledAt: null },
      reconciled({ discovered: [worktree] }),
    );

    expect(harness.claims).toContain('worktree:worktree-1:worktree.discovered');
    expect(harness.claims).not.toContain('worktree:worktree-1:worktree.created');
  });

  it('announces the workspace and the repository once each, ahead of any worktree', async () => {
    const harness = createHarness({ tasks: {} });

    await harness.dispatcher.onReconciled(repository, reconciled({ discovered: [worktree] }));
    await harness.dispatcher.onReconciled(repository, reconciled({ updated: [worktree] }));

    expect(harness.claims.slice(0, 2)).toEqual([
      'workspace:workspace-1:workspace.discovered',
      'repository:repository-1:repo.discovered',
    ]);
    expect(harness.claims.filter((claim) => claim.endsWith('workspace.discovered'))).toHaveLength(1);
  });

  it('leaves preparation to the first task under the default lazy mode', async () => {
    const harness = createHarness({ prepare: { mode: 'lazy' }, tasks: {} });

    await harness.dispatcher.prepareDiscovered(worktree);

    expect(harness.claims).not.toContain('worktree:worktree-1:worktree.ready');
  });

  it('prepares an eager worktree as soon as it is discovered, and says it is ready', async () => {
    const harness = createHarness({ prepare: { mode: 'eager' }, tasks: {} });

    await harness.dispatcher.prepareDiscovered(worktree);

    expect(harness.claims).toContain('worktree:worktree-1:worktree.ready');
    expect(harness.allocations.slice(0, 2)).toEqual([false, true]);
  });
});

function reconciled(result: Partial<ReconcileResult>): ReconcileResult {
  return { discovered: [], updated: [], orphaned: [], ...result };
}
