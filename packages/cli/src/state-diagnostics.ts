import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import {
  DaemonSocketPathTooLongError,
  measureDaemonSocketPath,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import { selectPlatformRuntime } from '@wtm/platform';
import type { PlatformRuntime } from '@wtm/platform/ports';
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
  /**
   * The daemon socket this host publishes. Defaults to this user's published path, because
   * `doctor` is answering about the machine it is running on; tests point it elsewhere.
   */
  daemonSocketPath?: string;
  /**
   * How the host platform is chosen, and the subject of the `platform` check.
   *
   * A thunk rather than a resolved runtime for one reason: `selectPlatformRuntime` *refuses* a
   * host it has no backend for, and the command that has to keep answering on such a host is
   * precisely this one. Taking the refusal here turns it into the `platform` finding instead of
   * an exception raised on the way to reporting it.
   *
   * It is also the seam the Linux answer is proven through. `doctor` asked about a linux runtime
   * from this macOS host reports linux's roots, systemd and 108 bytes, which is the only way that
   * half of the report can be tested at all before C2.
   */
  selectPlatform?: () => PlatformRuntime;
}

/**
 * How long the reachability probe waits before calling the daemon absent.
 *
 * `doctor` is a read command a person is watching, so the probe is bounded rather than left to
 * the operating system's connect timeout. A daemon that has accepted the connection answers in
 * microseconds — a Unix socket has no network in it — so this budget is for a machine under
 * load, not for a slow answer.
 */
const daemonProbeTimeoutMs = 500;

/**
 * How little headroom is worth warning about, in bytes.
 *
 * The one thing that moves this measurement is the depth of the user's home directory, and it
 * moves in whole path segments. Under 16 bytes is less than one ordinary directory name, so a
 * home that is moved or re-created one level deeper stops the daemon binding at all — which is
 * the failure this warning exists to arrive before.
 */
const socketPathWarningHeadroomBytes = 16;

export function createStateDiagnosticDataSource(
  store: DaemonStateStore,
  options: StateDiagnosticOptions,
): DiagnosticDataSource {
  const registered = (workspace: WorkspaceRecord): RegisteredWorkspace => ({
    id: workspace.id, name: workspace.name, root: workspace.root, scope: workspace.scope,
  });

  /**
   * The host, chosen once and remembered — refusal included.
   *
   * Once, because three answers below are drawn from it and a second selection is a second
   * chance to disagree. Refusal included, because a host WTM has no backend for still gets a
   * report: `platform` says why, and the checks that cannot be answered without a platform say
   * nothing rather than guessing. The guess is what this increment removes — every one of these
   * roots used to be spelled `~/Library/...` here, on every operating system.
   */
  const chooseHost = options.selectPlatform ?? (() => selectPlatformRuntime());
  let host: { runtime: PlatformRuntime; refusal: null } | { runtime: null; refusal: unknown } | null = null;
  const platform = () => (host ??= selectHost(chooseHost));

  /**
   * The address `doctor` measures and probes, or `null` when there is no platform to derive one
   * from. It is deliberately the same derivation the CLI's own connect side uses, so the path
   * the doctor reports on cannot be a different path from the one every command dials.
   */
  const socketPathFor = (): string | null => {
    if (options.daemonSocketPath !== undefined) return options.daemonSocketPath;
    const runtime = platform().runtime;
    return runtime === null ? null : publishedDaemonSocketPath(runtime.paths.socketRoot);
  };
  let reachabilityProbe: Promise<boolean> | null = null;

  /**
   * The worktree the question is about — only ever one that actually contains the directory
   * the question was asked in.
   *
   * `status` used to answer for whichever worktree the registry happened to list first, so
   * standing in one branch's directory reported another branch's state, and in a workspace of
   * several repositories, another repository's. Narrowing it to the containing worktree fixed
   * that for directories WTM knows; falling back to the first one when it knows none kept the
   * same bug for the case that matters most. A worktree created a moment ago, before the
   * daemon has read it, is exactly such a directory: `wtm status` inside a new feature branch
   * reported `main` — its branch, its state, its ports — with nothing to say it had answered
   * about somewhere else. No worktree is a truthful answer; the wrong worktree is not.
   */
  const currentWorktree = (workspaceId: string): WorktreeRecord | undefined => workspaceWorktrees(workspaceId)
    .filter((worktree) => containsPath(worktree.path, options.cwd))
    .sort((left, right) => right.path.length - left.path.length)[0];

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
    findings.push(await registrationFinding());
    findings.push(platformFinding());
    const socketPath = socketPathFinding();
    if (socketPath !== null) findings.push(socketPath);
    return findings;
  };

  /**
   * Which operating system WTM decided it is on, and every answer that decision settles.
   *
   * Item 9's last acceptance criterion is that the platform-specific differences are *reported*,
   * and this is where they are. Not because a user cannot look them up, but because until this
   * increment there was nothing to look up: the roots were spelled out at four call sites, the
   * socket limit at five, and all nine said macOS whatever the host was. A single finding naming
   * the runtime, its service manager, its three roots and its socket limit is how a reader
   * confirms WTM agrees with them about where its files are — and it is the first thing to read
   * when it does not.
   *
   * `pass` or `error`, and nothing between. There is no partial platform: either
   * `selectPlatformRuntime` produced a runtime, in which case every answer below it is settled,
   * or it refused the host, in which case nothing is. A `warning` here would be a state WTM
   * cannot be in.
   */
  const platformFinding = (): DoctorDiagnostic['findings'][number] => {
    const chosen = platform();
    if (chosen.runtime === null) {
      return {
        check: 'platform',
        status: 'error',
        message: messageOf(chosen.refusal),
        details: { code: refusalCode(chosen.refusal) },
      };
    }
    const { id, paths, socket, service } = chosen.runtime;
    return {
      check: 'platform',
      status: 'pass',
      message: `${id}, with ${service.managerName} as the service manager. Data in `
        + `${paths.dataRoot}, logs in ${paths.logRoot}, the daemon socket in ${paths.socketRoot}, `
        + `under a ${socket.limitBytes}-byte socket address limit.`,
      details: {
        code: null,
        platform: id,
        serviceManager: service.managerName,
        dataRoot: paths.dataRoot,
        logRoot: paths.logRoot,
        socketRoot: paths.socketRoot,
        socketLimitBytes: socket.limitBytes,
      },
    };
  };

  /**
   * Whether WTM can answer about this directory at all, and if not, which of the two reasons
   * it is.
   *
   * "The daemon is not running" and "this directory is in no registered worktree" are separate
   * states with separate codes and separate exit codes — `WTM_DAEMON_UNAVAILABLE` exits 4,
   * `WTM_WORKSPACE_NOT_FOUND` exits 2 — and the remedy for one does nothing for the other.
   * They used to reach the reader as the same shrug, so the person whose daemon was down was
   * told to run `wtm init`, and the person in an unregistered worktree was told nothing at all.
   *
   * This is the only check that touches the daemon. Every other one answers from the store,
   * and reachability is not answerable from the store: a registry written by a daemon that has
   * since exited reads exactly like one written by a daemon that is still serving.
   */
  const registrationFinding = async (): Promise<DoctorDiagnostic['findings'][number]> => {
    const reachable = await daemonReachable();
    try {
      findRegistration(store, options.cwd);
    } catch (error) {
      return {
        check: 'registration',
        status: 'error',
        message: messageOf(error),
        details: { code: 'WTM_WORKSPACE_NOT_FOUND', registered: false, daemonReachable: reachable },
      };
    }
    return reachable
      ? {
        check: 'registration',
        status: 'pass',
        message: 'This worktree is registered, and the daemon is answering.',
        details: { code: null, registered: true, daemonReachable: true },
      }
      : {
        check: 'registration',
        status: 'warning',
        message: 'This worktree is registered, but the daemon is not answering on its socket. '
          + 'Start it with `wtm daemon start`.',
        details: { code: 'WTM_DAEMON_UNAVAILABLE', registered: true, daemonReachable: false },
      };
  };

  /**
   * Whether the daemon's socket address still fits, and how much room is left before it stops.
   *
   * The first check that is about the host rather than the workspace: the answer is the same
   * in every workspace on this machine, because what it measures is the length of the user's
   * home directory. It is reported while it is still a number and not yet a failure — once the
   * limit is breached the daemon cannot bind at all, and a diagnostic that only speaks then is
   * speaking to someone who has already lost the daemon that would have run it.
   */
  const socketPathFinding = (): DoctorDiagnostic['findings'][number] | null => {
    const chosen = platform();
    const socketPath = socketPathFor();
    // No platform is no limit and no address: there is nothing to measure, and inventing a limit
    // to measure against is how this file came to state macOS's 104 on every operating system.
    // Left out entirely, the envelope back-fills it as `unknown`, which is what it is — and
    // `platform`, directly above, carries the reason.
    if (chosen.runtime === null || socketPath === null) return null;
    const measurement = measureDaemonSocketPath(socketPath, chosen.runtime.socket.limitBytes);
    const headroom = measurement.limitBytes - measurement.byteLength;
    const details = {
      byteLength: measurement.byteLength,
      limitBytes: measurement.limitBytes,
      headroom,
      path: measurement.measuredPath,
    };
    if (!measurement.fits) {
      return {
        check: 'socket-path',
        status: 'error',
        message: new DaemonSocketPathTooLongError(measurement).message,
        details: { ...details, code: 'WTM_SOCKET_PATH_TOO_LONG' },
      };
    }
    return headroom < socketPathWarningHeadroomBytes
      ? {
        check: 'socket-path',
        status: 'warning',
        message: `The daemon socket path has ${headroom} `
          + `${plural(headroom, 'byte', 'bytes')} of headroom (${measurement.byteLength} of `
          + `${measurement.limitBytes}). One more directory level in your home path and the `
          + 'daemon cannot bind it.',
        details: { ...details, code: null },
      }
      : {
        check: 'socket-path',
        status: 'pass',
        message: `The daemon socket path fits with ${headroom} `
          + `${plural(headroom, 'byte', 'bytes')} to spare (${measurement.byteLength} of `
          + `${measurement.limitBytes}).`,
        details: { ...details, code: null },
      };
  };

  /**
   * Whether something is listening on the daemon's socket, without asking it anything.
   *
   * A connect is the whole question: the socket file outliving the process it belonged to is
   * exactly the case a stat cannot tell apart, and a running daemon accepts. Nothing is sent,
   * so this cannot disturb a daemon that is mid-request.
   */
  const daemonReachable = async (): Promise<boolean> => {
    // One answer per command, not one per workspace: the socket is a property of the host, so
    // `doctor --global` across five workspaces would otherwise open five connections and wait
    // up to five timeouts to learn the same fact five times.
    reachabilityProbe ??= probeDaemon();
    return await reachabilityProbe;
  };

  const probeDaemon = async (): Promise<boolean> => new Promise<boolean>((settle) => {
    const socketPath = socketPathFor();
    // No platform, no address to dial. Reporting the daemon absent is the truthful answer: a host
    // WTM has no backend for has no daemon on it either, and `platform` says why.
    if (socketPath === null) {
      settle(false);
      return;
    }
    let socket: ReturnType<typeof createConnection>;
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      // A path too long for an address raises synchronously; `socket-path` explains that one.
      settle(false);
      return;
    }
    socket.unref();
    let settled = false;
    const answer = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      settle(reachable);
    };
    // `on`, not `once`: the listener has to outlive the answer, or the `destroy` below can
    // raise an `error` event with nothing listening, which Node turns into a thrown exception.
    socket.on('error', () => answer(false));
    socket.setTimeout(daemonProbeTimeoutMs, () => answer(false));
    socket.once('connect', () => answer(true));
  });

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
    let registration;
    try {
      registration = findRegistration(store, options.cwd);
    } catch {
      // "This directory is not inside a worktree WTM has registered" used to arrive here, as an
      // `adapters` finding of status `unknown` — the one heading a reader asking why WTM does
      // not know about this directory would never open. It is the `registration` check's answer
      // now, and this check says only why it has nothing of its own to report.
      return {
        check: 'adapters',
        status: 'unknown',
        message: 'Adapter detection needs a registered worktree; see the registration check.',
      };
    }
    let inspection;
    try {
      inspection = await inspectAdapters(adapterContext(registration));
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

/**
 * The host, or the refusal, as a value rather than as an exception.
 *
 * Deliberately catches everything, not only `UnsupportedPlatformError`: the composition root also
 * refuses a home that is not absolute, and a `doctor` that dies on the way to explaining why is
 * worse than useless to the person whose environment is the problem.
 */
function selectHost(
  choose: () => PlatformRuntime,
): { runtime: PlatformRuntime; refusal: null } | { runtime: null; refusal: unknown } {
  try {
    return { runtime: choose(), refusal: null };
  } catch (error) {
    return { runtime: null, refusal: error };
  }
}

/**
 * The code a refusal carries, reported so the finding names the same code the envelope would.
 * `UnsupportedPlatformError` carries `WTM_PLATFORM_UNSUPPORTED`; anything else declares nothing,
 * and a details row is not the place to invent one.
 */
function refusalCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
