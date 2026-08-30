import { lstat } from 'node:fs/promises';
import {
  containsPath,
  parsePortRange,
  resolveWorkspaceConfig,
  type DaemonStateStore,
  type WorkspaceRecord,
  type WorktreeRecord,
} from '@wtm/core';
import {
  adapterContext,
  execEnvironment,
  findRegistration,
  inspectAdapters,
  inspectRuntimeResources,
  resolveWorktreeRuntime,
  type AdapterReport,
  type WorktreeRuntime,
} from '@wtm/daemon';
import { planChanges } from './changes';
import { explainDecisions } from './decisions';
import type {
  DiagnosticDataSource,
  DoctorDiagnostic,
  ExplainDiagnostic,
  PlanDiagnostic,
  RegisteredWorkspace,
  StatusDiagnostic,
} from './diagnostics';

export interface StateDiagnosticOptions {
  /** The directory the command was run in, which is what decides *which* worktree it is about. */
  cwd: string;
  globalConfigPath: string;
}

export function createStateDiagnosticDataSource(
  store: DaemonStateStore,
  options: StateDiagnosticOptions,
): DiagnosticDataSource {
  const registered = (workspace: WorkspaceRecord): RegisteredWorkspace => ({
    id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope,
  });

  /**
   * The worktree the question is about. `status` used to answer for whichever worktree the
   * registry happened to list first, so standing in one branch's directory reported another
   * branch's state — and in a workspace of several repositories, another repository's.
   */
  const currentWorktree = (workspaceId: string): WorktreeRecord | undefined => {
    const worktrees = workspaceWorktrees(workspaceId);
    const containing = worktrees
      .filter((worktree) => containsPath(worktree.path, options.cwd))
      .sort((left, right) => right.path.length - left.path.length)[0];
    return containing ?? worktrees[0];
  };

  /** Every worktree of this workspace that shares the given worktree's branch. */
  const featureWorktreeIds = (workspaceId: string, worktree: WorktreeRecord): string[] => {
    if (worktree.branch === null) return [worktree.id];
    return workspaceWorktrees(workspaceId)
      .filter((candidate) => candidate.branch === worktree.branch)
      .map(({ id }) => id);
  };

  const workspaceWorktrees = (workspaceId: string): WorktreeRecord[] => {
    const repositoryIds = new Set(store.listRepositories(workspaceId).map(({ id }) => id));
    return store.listWorktrees().filter(({ repositoryId }) => repositoryIds.has(repositoryId));
  };

  /**
   * What the workspace's `[resources]` table asks for, and whether this worktree has it. The
   * list was hard-coded empty, so a resource that had never been materialized looked exactly
   * like a workspace that declared none.
   */
  /**
   * The runtime for the worktree the command was run in. `allocate: false` answers from the
   * leases that exist rather than taking one, which is what a command that only reports must
   * do — asking `wtm plan` which endpoints have no port must not give them one.
   */
  const worktreeRuntime = async (allocate: boolean): Promise<WorktreeRuntime> =>
    await resolveWorktreeRuntime({
      store,
      cwd: options.cwd,
      globalConfigPath: options.globalConfigPath,
      ...(allocate ? {} : { allocate: false }),
    });

  const adapters = async (runtime: WorktreeRuntime): Promise<AdapterReport[]> => {
    try {
      return (await inspectAdapters(adapterContext(runtime.registration))).adapters;
    } catch {
      return [];
    }
  };

  const declaredResources = async (): Promise<StatusDiagnostic['resources']> => {
    try {
      return await inspectRuntimeResources(await resolveWorktreeRuntime({
        store,
        cwd: options.cwd,
        globalConfigPath: options.globalConfigPath,
      }));
    } catch {
      return [];
    }
  };


  /**
   * The deterministic checks `wtm doctor` answers. Every one of them used to report `unknown`,
   * which is the least useful thing a diagnostic can say: a workspace whose registered
   * repository had been deleted, whose preferred port could never be offered, or whose
   * resources had never been created all looked exactly like a healthy one.
   */
  const diagnose = async (workspace: RegisteredWorkspace): Promise<DoctorDiagnostic['findings']> => {
    const repositories = store.listRepositories(workspace.id);
    const worktrees = workspaceWorktrees(workspace.id);
    const current = currentWorktree(workspace.id);

    const unavailable: string[] = [];
    for (const repository of repositories) {
      if (!await isDirectory(repository.mainRoot)) unavailable.push(repository.mainRoot);
    }

    const findings: DoctorDiagnostic['findings'] = [{
      check: 'git',
      status: unavailable.length === 0 ? 'pass' : 'error',
      message: unavailable.length === 0
        ? `${repositories.length} registered ${plural(repositories.length, 'repository', 'repositories')}, all present.`
        : `${unavailable.length} registered ${plural(unavailable.length, 'repository', 'repositories')} `
          + `no longer on disk, starting with ${unavailable[0]}. WTM keeps serving the rest; `
          + 'the registration returns on its own if the directory comes back.',
      details: { registered: repositories.length, unavailable: unavailable.length },
    }];

    findings.push(await configFinding(workspace, current));
    findings.push(await adapterFinding());
    findings.push(await resourceFinding());
    findings.push(portFinding(workspace, worktrees));
    findings.push(processFinding(worktrees));
    return findings;
  };

  const configFinding = async (
    workspace: RegisteredWorkspace,
    worktree: WorktreeRecord | undefined,
  ): Promise<DoctorDiagnostic['findings'][number]> => {
    let config;
    try {
      config = await resolveWorkspaceConfig({
        workspaceRoot: workspace.root,
        repoRoot: worktree?.path ?? workspace.root,
        globalConfigPath: options.globalConfigPath,
      });
    } catch (error) {
      return { check: 'config', status: 'error', message: messageOf(error) };
    }
    const ports = config.value.ports;
    if (ports === undefined) return { check: 'config', status: 'pass', message: 'The configuration resolves.' };
    let range;
    try {
      range = parsePortRange(ports.range);
    } catch (error) {
      return { check: 'config', status: 'error', message: messageOf(error) };
    }
    // The one configuration mistake that used to be silent: a preferred port the band can
    // never offer, so the endpoint quietly landed somewhere the configuration never mentions.
    const outside = Object.entries(ports)
      .filter(([name]) => name !== 'strategy' && name !== 'range')
      .filter(([, value]) => {
        const preferred = (value as { preferred?: unknown }).preferred;
        return typeof preferred === 'number' && (preferred < range.min || preferred > range.max);
      })
      .map(([name]) => name);
    return outside.length === 0
      ? { check: 'config', status: 'pass', message: 'The configuration resolves.' }
      : {
        check: 'config',
        status: 'error',
        message: `[ports].range = "${ports.range ?? ''}" cannot offer the port ${outside.join(', ')} `
          + `${plural(outside.length, 'asks', 'ask')} for. Widen the range, or drop the preference.`,
        details: { ports: outside.join(', '), range: `${range.min}-${range.max}` },
      };
  };

  /**
   * Which adapters are in force here. Two package managers in one repository is ordinary, and
   * exactly one of them wins; a check that always said `unknown` left the person whose wrong
   * `dev` command ran with nowhere to look.
   */
  const adapterFinding = async (): Promise<DoctorDiagnostic['findings'][number]> => {
    let inspection;
    try {
      inspection = await inspectAdapters(adapterContext(findRegistration(store, options.cwd)));
    } catch (error) {
      return { check: 'adapters', status: 'unknown', message: messageOf(error) };
    }
    const active = inspection.adapters.filter(({ active: isActive }) => isActive);
    if (inspection.findings.length > 0) {
      return {
        check: 'adapters',
        status: 'error',
        message: inspection.findings.map(({ message }) => message).join(' '),
        details: { detected: inspection.adapters.length, active: active.length },
      };
    }
    return {
      check: 'adapters',
      status: 'pass',
      message: active.length === 0
        ? 'No built-in adapter recognizes this worktree; only configured tasks are available.'
        : `${active.map(({ id }) => id).join(', ')} in force, contributing `
          + `${new Set(active.flatMap(({ tasks }) => tasks)).size} ${plural(new Set(active.flatMap(({ tasks }) => tasks)).size, 'task', 'tasks')}.`,
      details: { detected: inspection.adapters.length, active: active.length },
    };
  };

  const resourceFinding = async (): Promise<DoctorDiagnostic['findings'][number]> => {
    const resources = await declaredResources();
    if (resources.length === 0) {
      return { check: 'resources', status: 'pass', message: 'This workspace declares no resources.' };
    }
    const degraded = resources.filter(({ state }) => state === 'degraded');
    return degraded.length === 0
      ? {
        check: 'resources',
        status: 'pass',
        message: `${resources.length} declared, `
          + `${resources.filter(({ state }) => state === 'ready').length} in place.`,
      }
      : {
        check: 'resources',
        status: 'warning',
        message: `${degraded[0]?.name}: ${degraded[0]?.detail ?? 'it could not be created.'}`,
        details: { degraded: degraded.length },
      };
  };

  const portFinding = (
    workspace: RegisteredWorkspace,
    worktrees: readonly WorktreeRecord[],
  ): DoctorDiagnostic['findings'][number] => {
    const leases = store.listEndpointLeases({ worktreeIds: worktrees.map(({ id }) => id), states: ['ACTIVE'] });
    const byPort = new Map<number, number>();
    for (const lease of leases) byPort.set(lease.port, (byPort.get(lease.port) ?? 0) + 1);
    const shared = [...byPort.entries()].filter(([, count]) => count > 1).map(([port]) => port);
    return shared.length === 0
      ? {
        check: 'ports',
        status: 'pass',
        message: `${leases.length} ${plural(leases.length, 'endpoint', 'endpoints')} leased in ${workspace.name}.`,
        details: { leases: leases.length },
      }
      : {
        check: 'ports',
        status: 'error',
        message: `Two worktrees hold the same port: ${shared.join(', ')}.`,
        details: { ports: shared.join(', ') },
      };
  };

  const processFinding = (worktrees: readonly WorktreeRecord[]): DoctorDiagnostic['findings'][number] => {
    const worktreeIds = new Set(worktrees.map(({ id }) => id));
    const running = store.listManagedProcesses({})
      .filter((record) => worktreeIds.has(record.worktreeId) && record.state === 'RUNNING');
    const gone = running.filter((record) => !isAlive(record.pid));
    return gone.length === 0
      ? {
        check: 'process-records',
        status: 'pass',
        message: `${running.length} supervised ${plural(running.length, 'task', 'tasks')} running.`,
        details: { running: running.length },
      }
      : {
        check: 'process-records',
        status: 'warning',
        message: `${gone.length} ${plural(gone.length, 'record', 'records')} say RUNNING for a process that is gone `
          + `(${gone.map(({ taskName }) => taskName).join(', ')}). The daemon reconciles them when it next starts.`,
        details: { stale: gone.length },
      };
  };

  /**
   * Every choice in force in this worktree. Unlike `plan`, this resolves the way a task would
   * — including leasing an endpoint that has none — because it reports what *is* decided, and
   * `wtm env` already answers that question the same way.
   */
  const explain = async (): Promise<ExplainDiagnostic['decisions']> => {
    const runtime = await worktreeRuntime(true);
    return explainDecisions({
      runtime,
      adapters: await adapters(runtime),
      resources: await inspectRuntimeResources(runtime),
      environment: execEnvironment(runtime),
    });
  };

  const proposed = async (workspace: RegisteredWorkspace): Promise<PlanDiagnostic['changes']> => {
    const runtime = await worktreeRuntime(false);
    const worktreeIds = new Set(workspaceWorktrees(workspace.id).map(({ id }) => id));
    return await planChanges({
      runtime,
      adapters: await adapters(runtime),
      resources: await inspectRuntimeResources(runtime),
      processes: store.listManagedProcesses({})
        .filter((record) => worktreeIds.has(record.worktreeId))
        .map((record) => ({ record, alive: isAlive(record.pid) })),
      repositoryRoots: store.listRepositories(workspace.id).map(({ mainRoot }) => mainRoot),
    });
  };

  return {
    listRegisteredWorkspaces: async () => store.listWorkspaces().map(registered),
    readStatus: async (workspace) => {
      const worktree = currentWorktree(workspace.id);
      const processes = worktree === undefined ? [] : store.listManagedProcesses({ worktreeId: worktree.id }).map((process) => ({
        task: process.taskName,
        pid: process.state === 'RUNNING' ? process.pid : null,
        state: process.state === 'RUNNING' ? 'running' as const : process.state === 'STALE_IDENTITY' ? 'stale' as const : 'stopped' as const,
        startedAt: process.startedAt,
        argv: [],
      }));
      return {
        workspace,
        identity: worktree === undefined ? {
          repositoryId: null, worktreeId: null, numericId: null, path: workspace.root,
          branch: null, headOid: null, isMain: true,
        } : {
          repositoryId: worktree.repositoryId,
          worktreeId: worktree.id,
          numericId: worktree.numericId,
          path: worktree.path,
          branch: worktree.branch,
          headOid: worktree.headOid,
          isMain: worktree.isMain,
        },
        state: worktree?.state ?? 'UNKNOWN',
        // A feature's endpoints are leased once for every repository that shares its branch,
        // so listing only this worktree's own leases shows nothing at all to the repository
        // that reads the other's port.
        endpoints: worktree === undefined ? [] : store.listEndpointLeases({
          worktreeIds: featureWorktreeIds(workspace.id, worktree),
          states: ['ACTIVE'],
        }),
        processes,
        // Only for the worktree the question is actually about: a `--global` status walks
        // workspaces this directory is nowhere near, and there is nothing to observe there.
        resources: worktree !== undefined && containsPath(worktree.path, options.cwd)
          ? await declaredResources()
          : [],
      } satisfies StatusDiagnostic;
    },
    readDoctor: async (workspace) => ({ workspace, findings: await diagnose(workspace) }),
    readExplain: async (workspace) => ({ workspace, decisions: await explain() }),
    readPlan: async (workspace) => ({ workspace, changes: await proposed(workspace) }),
    readEnv: async (workspace) => ({
      workspace,
      // Resolving allocates whatever this worktree is owed, which is the only way the answer
      // can name the port a task would actually be started with.
      variables: execEnvironment(await resolveWorktreeRuntime({
        store,
        cwd: options.cwd,
        globalConfigPath: options.globalConfigPath,
      })),
    }),
    readPorts: async (workspace) => ({
      workspace,
      leases: store.listEndpointLeases({
        worktreeIds: workspaceWorktrees(workspace.id).map(({ id }) => id),
        states: ['ACTIVE'],
      }),
    }),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the operating system still knows this process, without disturbing it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
