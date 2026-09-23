import { homedir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { checklistCommandNames, ciCommandNames, jobCommandNames, taskOverrideCommandNames } from '@wtm/protocol';
import { basename as posixBasename, dirname as posixDirname, join as posixJoin, resolve as posixResolve } from 'node:path/posix';
import { basename as win32Basename, dirname as win32Dirname, join as win32Join, resolve as win32Resolve } from 'node:path/win32';
import {
  executablePathResolverFor, readHeavyJobScope, selectPlatformRuntime, windowsNamedPipeRootFor,
} from '@wtm/platform';
import type { FileTrustPolicy, PlatformId, PlatformRuntime } from '@wtm/platform/ports';
import {
  assertDaemonSocketPathFits,
  daemonSocketFileName,
} from '@wtm/platform/socket';
import {
  SQLiteStateStore,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  resolveTask,
  containsPath,
  HeavyJobError,
  applyTaskOverrides,
  idlePolicies,
  parseWtmConfig,
  queueTaskTimeoutMs,
  resolveWorkspaceConfig,
  useGitExecutableResolver,
  type DaemonStateStore,
  type IdlePolicy,
  type LifecycleEventStore,
  type WtmConfig,
} from '@wtm/core';
import { CiWatcher } from './ci/watcher';
import { createGhRunner } from './ci/gh-runner';
import { createGitHubProvider } from './ci/github-provider';
import { TaskOverridesHandler } from './task-overrides-handler';
import { ChecklistHandler } from './checklist-handler';
import { LifecycleEventDispatcher } from './events';
import { WtmDaemon } from './main';
import { ManagedLogStore } from './logs';
import { HeavyJobQueue, type ResolvedHeavyJob } from './heavy-job-queue';
import { IdleRuntimeSuspender } from './idle-runtime';
import { ManagedProcessSupervisor, type RuntimeInvocation } from './process-supervisor';
import { checklistApiHandler, devOverlayHtmlInjector } from './dev-overlay';
import { defaultProxyPort, ProxyServer } from './proxy';
import { globalDevOverlayPolicy, globalProxyPolicy } from './proxy-policy';
import { buildProxyRoutes } from './proxy-routes';
import { DaemonRuntimeController, type DaemonRuntimeResolver } from './runtime-controller';
import {
  execEnvironment,
  findRegistration,
  prepareRuntimeResources,
  resolveWorktreeRuntime,
  taskResolutionInput,
} from './task-resolution';

export interface ProductionRuntimePaths {
  dataRoot: string;
  databasePath: string;
  socketPath: string;
  logRoot: string;
  globalConfigPath: string;
}

export interface ProductionDaemonOptions {
  /**
   * The machine this daemon is running on. Injected so a test can run the Linux policy on a macOS
   * host; production selects it here, which is what makes this function the composition root.
   */
  platformRuntime?: PlatformRuntime;
  dataRoot?: string;
  databasePath?: string;
  socketPath?: string;
  logRoot?: string;
  globalConfigPath?: string;
  stateStore?: DaemonStateStore & { close?(): void };
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
  runtimeInvocation?: RuntimeInvocation;
  /** How often opted-in managed tasks are checked for idleness. See `idle-runtime.ts`. */
  idleSweepIntervalMs?: number;
  /**
   * The loopback addresses the local reverse proxy binds, when `[proxy] enabled = true`.
   * Defaults to `ProxyServer`'s own default (`127.0.0.1` and `::1`). Injectable so a test can
   * bind `127.0.0.1` alone on a sandbox without IPv6, the same reason `platformRuntime` above is.
   */
  proxyHosts?: readonly string[];
}

export interface ProductionDaemonRuntime {
  paths: ProductionRuntimePaths;
  stateStore: DaemonStateStore;
  logs: ManagedLogStore;
  supervisor: ManagedProcessSupervisor;
  controller: DaemonRuntimeController;
  idle: IdleRuntimeSuspender;
  daemon: WtmDaemon;
  jobs: HeavyJobQueue | null;
  ci: CiWatcher | null;
  taskOverrides: TaskOverridesHandler | null;
  checklist: ChecklistHandler | null;
  /** `null` unless `[proxy] enabled = true` in the global configuration. See `proxy.ts`. */
  proxy: ProxyServer | null;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The state database's file name. Only its directory is a platform question. */
const databaseFileName = 'state.db';

/**
 * The `node:path` module for `platform`'s filesystem rules, not the host's.
 *
 * A real CI run surfaced this the same way `select.ts` already needed it: the default `node:path`
 * follows the *host*, so building `databasePath`/`socketPath`/`globalConfigPath` with a plain
 * `join`/`resolve` mangled a POSIX `dataRoot` like `/Users/somebody/Library/...` into
 * `\Users\somebody\Library\...` on a Windows host asked for the `darwin`/`linux` runtime
 * `runtime-factory.test.ts` (and `createProductionDaemon`'s own `platformRuntime` injection point)
 * construct. Every path built in this file from an already-resolved `PlatformRuntime`'s roots goes
 * through this instead of the default import.
 */
function pathModuleFor(platform: PlatformId) {
  return platform === 'win32'
    ? { join: win32Join, resolve: win32Resolve, dirname: win32Dirname, basename: win32Basename }
    : { join: posixJoin, resolve: posixResolve, dirname: posixDirname, basename: posixBasename };
}

export interface ProductionRuntimePathsOptions {
  platform?: NodeJS.Platform | string;
  env?: Readonly<Partial<Record<string, string>>>;
}

/**
 * The daemon's five paths, read off a platform runtime.
 *
 * Every root used to be spelled here: `~/Library/Application Support/WTM`, `~/Library/Logs/WTM`,
 * and a socket path derived from the data root. Two of those are macOS facts and the third is a
 * macOS coincidence — the socket sits beside the database on macOS because macOS offers nowhere
 * shorter to put it, whereas on Linux `$XDG_RUNTIME_DIR` is a different filesystem chosen by a
 * different variable. So `socketPath` comes from `paths.socketRoot`, which is why `PlatformPaths`
 * states that as a field rather than leaving it to be derived: a derivation from `dataRoot` would
 * be silently wrong on Linux and there would be nothing in the type to say so.
 */
export function runtimePathsFor(runtime: PlatformRuntime): ProductionRuntimePaths {
  const { paths } = runtime;
  const { join } = pathModuleFor(runtime.id);
  return {
    dataRoot: paths.dataRoot,
    databasePath: join(paths.dataRoot, databaseFileName),
    socketPath: join(paths.socketRoot, daemonSocketFileName),
    logRoot: paths.logRoot,
    globalConfigPath: paths.configPath,
  };
}

/**
 * `home` stays a positional argument with a default because the CLI calls this a dozen times with
 * no arguments at all; `platform` and `env` are injectable for the same reason every port in
 * `@wtm/platform` takes them, which is that the Linux layout has to be assertable from this macOS
 * machine. `selectPlatformRuntime` is also where `home` is validated, once, for every port.
 */
export function defaultProductionRuntimePaths(
  home = homedir(),
  options: ProductionRuntimePathsOptions = {},
): ProductionRuntimePaths {
  return runtimePathsFor(selectPlatformRuntime({ home, ...options }));
}

/** Pure path resolution shared by production startup and cross-platform validation. */
export function resolveProductionRuntimePaths(
  platformRuntime: PlatformRuntime,
  options: Pick<ProductionDaemonOptions, 'dataRoot' | 'databasePath' | 'socketPath' | 'logRoot' | 'globalConfigPath'> = {},
): ProductionRuntimePaths {
  const { join, resolve } = pathModuleFor(platformRuntime.id);
  const defaults = runtimePathsFor(platformRuntime);
  const dataRoot = resolve(options.dataRoot ?? defaults.dataRoot);
  return {
    dataRoot,
    databasePath: resolve(options.databasePath ?? join(dataRoot, databaseFileName)),
    // A caller who moved the data root gets its socket moved with it, even on a platform whose
    // default socket root is elsewhere: an isolated instance that kept the shared
    // `$XDG_RUNTIME_DIR` address would collide with the installed daemon, which is the one
    // failure a caller passing `dataRoot` is trying to avoid. Only the untouched default reads
    // the platform's socket root.
    socketPath: resolve(options.socketPath
      ?? (options.dataRoot === undefined ? defaults.socketPath
        : join(platformRuntime.id === 'win32' ? windowsNamedPipeRootFor(dataRoot) : dataRoot, daemonSocketFileName))),
    logRoot: resolve(options.logRoot ?? defaults.logRoot),
    // Same reasoning as `socketPath` just above: the untouched default reads the platform's own
    // documented config location (`docs/03`'s XDG/macOS/Windows paths), which is not generally
    // `dataRoot`-relative (Linux keeps them in different directories entirely). Only a caller who
    // explicitly relocated `dataRoot` gets `globalConfigPath` moved with it, as isolation
    // convenience — this was the one path here that fell back to `join(dataRoot, ...)`
    // unconditionally, which meant a real `wtm daemon serve` (no `dataRoot` override, the actual
    // production call) silently read global config from the wrong directory and never enforced
    // `[budgets]`/`[jobs]`/`[proxy]` from the documented `~/.config/wtm/config.toml`.
    globalConfigPath: resolve(options.globalConfigPath
      ?? (options.dataRoot === undefined ? defaults.globalConfigPath : join(dataRoot, 'config.toml'))),
  };
}

export async function createProductionDaemon(options: ProductionDaemonOptions = {}): Promise<ProductionDaemonRuntime> {
  const platformRuntime = options.platformRuntime ?? selectPlatformRuntime();
  // `@wtm/core`'s `listGitWorktrees`/`runGit` cannot know their own host (spec D1); the
  // composition root that just chose one hands it the search that host's `spawn` actually
  // performs, the same seam `cli`'s own `hostPlatformRuntime()` installs. Without it a `git`
  // shadowed earlier on `PATH` -- the daemon's reconcile pass runs on every registered
  // repository -- is invisible on win32, where only `.com`/`.exe` are found by a bare name.
  useGitExecutableResolver(executablePathResolverFor(platformRuntime.id));
  const { join, dirname, basename } = pathModuleFor(platformRuntime.id);
  const requestedPaths = resolveProductionRuntimePaths(platformRuntime, options);
  const { dataRoot } = requestedPaths;
  // Before the data directory exists. A socket path that cannot fit in a socket address is
  // not a reason to bring a state directory, a database and a log root into being first, and
  // failing here means the report names the path rather than whatever the next step tripped on.
  // The limit is the selected platform's — 104 bytes on macOS, 108 on Linux — rather than a
  // constant: measuring a Linux path against macOS's number refuses addresses that would bind.
  assertDaemonSocketPathFits(requestedPaths.socketPath, platformRuntime.socket.limitBytes);
  // Both calls below default to `defaultCoreFileTrustPolicy` (core's POSIX-only fallback) when
  // not given one explicitly, and that default's `currentIdentityAvailable()` is
  // `process.getuid?.() !== undefined` -- always `false` on win32. Omitting `platformRuntime
  // .fileTrust` here meant the composition root that exists specifically to select the right
  // trust policy never reached these two calls at all, so a real Windows daemon would refuse to
  // create its own data root on every single start -- confirmed on a real windows-latest leg.
  await ensurePrivateDirectory(dataRoot, platformRuntime.fileTrust);
  const ownedStore = options.stateStore === undefined;
  const databaseParent = ownedStore
    ? await ensurePrivateDirectory(dirname(requestedPaths.databasePath), platformRuntime.fileTrust)
    : undefined;
  const paths: ProductionRuntimePaths = {
    ...requestedPaths,
    databasePath: databaseParent === undefined
      ? requestedPaths.databasePath
      : join(databaseParent.path, basename(requestedPaths.databasePath)),
  };
  const stateStore = options.stateStore ?? new SQLiteStateStore(paths.databasePath);
  if (databaseParent !== undefined) {
    try { await verifyPrivateDirectory(databaseParent, platformRuntime.fileTrust); }
    catch (error) {
      (stateStore as SQLiteStateStore).close();
      throw error;
    }
  }
  let queueScope: string | null = null;
  if (stateStore.jobs !== undefined) {
    try { queueScope = await readHeavyJobScope(platformRuntime.id); stateStore.jobs.assertScope(queueScope); }
    catch (error) { if (ownedStore) (stateStore as SQLiteStateStore).close(); throw error; }
  }
  const logs = new ManagedLogStore({
    root: paths.logRoot,
    // The same reason `supervisor` below is handed `platformRuntime.process` rather than reading
    // the host itself: the composition root already chose a platform, and a log store answering
    // its own directory-safety questions from a different one is the class of drift this seam
    // exists to remove.
    fileTrust: platformRuntime.fileTrust,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  let jobs: HeavyJobQueue | null = null;
  const supervisor = new ManagedProcessSupervisor({
    stateStore,
    logs,
    onExit: (record, outcome) => { jobs?.recordExit(record, outcome); },
    // The supervisor's own defaults read the host, which is right for a daemon nobody handed a
    // runtime to and wrong for this one: the composition root has already chosen a platform, and
    // a supervisor inspecting processes through a different one than the daemon was built for is
    // the exact class of drift the seam exists to remove.
    //
    // `platform` is part of that and was missing while the two readers below were not, which made
    // the omission invisible: the readers are what a *test* observes, and the platform is what the
    // spawned anchor is told. An injected runtime for the other platform — which
    // `runtime-factory.test.ts` constructs — would have produced an anchor reporting its identity
    // in the host's dialect and a port reading it in the injected one, and the two dialects cannot
    // compare equal. That surfaces as `ANCHOR_IDENTITY_MISMATCH`, which blames the process for
    // changing identity when in fact nobody ever asked it the same question twice.
    platform: platformRuntime.id,
    inspectProcess: async (pid) => await platformRuntime.process.inspectProcess(pid),
    inspectProcessGroup: async (pgid) => await platformRuntime.process.inspectProcessGroup(pgid),
    signalProcessGroup: (pgid, signal) => { platformRuntime.process.signalProcessGroup(pgid, signal); },
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.runtimeInvocation === undefined ? {} : { runtimeInvocation: options.runtimeInvocation }),
  });
  const onError = options.onError ?? (() => {});
  // Read here, ahead of `events` below, rather than at its previous spot just before `controller`:
  // the dispatcher needs the same resolved budgets the controller does, and this is a plain async
  // config read with no dependency on `supervisor`/`controller`, so hoisting it costs nothing.
  const budgetsPolicy = await globalBudgetsPolicy(paths.globalConfigPath);
  const resolvedBudgets = {
    ...(budgetsPolicy.max_processes === undefined ? {} : { maxProcesses: budgetsPolicy.max_processes }),
    ...(budgetsPolicy.min_available_memory_mib === undefined ? {} : {
      minAvailableMemoryBytes: budgetsPolicy.min_available_memory_mib * 1024 * 1024,
    }),
  };
  const events = new LifecycleEventDispatcher({
    store: stateStore as DaemonStateStore & LifecycleEventStore,
    globalConfigPath: paths.globalConfigPath,
    start: async (input) => await supervisor.start(input),
    // The same policy the resolver below is handed. The event path and the task path prepare the
    // same worktree's resources through the same core call; the two answering from differently
    // selected policies is a divergence nothing would report until one of them refused.
    fileTrust: platformRuntime.fileTrust,
    onError,
    // The same `[budgets]` admission gate `controller` below applies to a person's own
    // `start`/`restart` — an event-triggered task is still a net-new managed process. See
    // `process-budgets.ts`'s own doc comment for why this was extracted (round-25 audit finding).
    supervisor,
    budgets: resolvedBudgets,
  });
  const idle = new IdleRuntimeSuspender({
    supervisor,
    // Read per sweep, from the workspace configuration plus any `wtm task set` override (see
    // `readIdlePolicies`): an idle window is a fact about the *effective* declared task, and
    // resolving a whole runtime — endpoints, adapters, resources — to learn one duration would
    // make the sweep cost more than what it reclaims.
    readIdlePolicies: async (worktreeId) => await readIdlePolicies(stateStore, paths.globalConfigPath, worktreeId),
    note: async (record, line) => { await logs.appendNote(record.worktreeId, record.taskName, line); },
    // An idle suspension is a stop, so the workspace's `[events."runtime.stopped"]` hears about it
    // exactly as it hears about `wtm stop`. Not awaited, for the reason the controller states.
    onSuspended: (record) => { void events.dispatchForWorktree('runtime.stopped', record.worktreeId).catch(onError); },
    onError,
    ...(options.idleSweepIntervalMs === undefined ? {} : { intervalMs: options.idleSweepIntervalMs }),
  });
  const resolver = new ProductionRuntimeResolver(stateStore, paths.globalConfigPath, (worktreeId) => {
    // Announced once per worktree, whichever timing prepared it: `eager` at discovery, `lazy`
    // here, before the first task. Dispatched without being awaited so that an event's own
    // task cannot be waiting on the start that is waiting on it.
    void events.dispatchForWorktree('worktree.ready', worktreeId).catch(onError);
  }, platformRuntime.fileTrust);
  const controller = new DaemonRuntimeController({
    supervisor,
    logs,
    resolver,
    inspectProcess: async (pid) => await platformRuntime.process.inspectProcess(pid),
    // Dispatching an event must not delay the reply to the person who started the task, and
    // must not fail it either: the task started, whatever the workspace hung off the event did.
    onRuntimeEvent: (event, worktreeId) => {
      void events.dispatchForWorktree(event, worktreeId).catch(onError);
    },
    onTaskActivity: (worktreeId, taskName) => { idle.touch(worktreeId, taskName); },
    budgets: resolvedBudgets,
  });
  if (stateStore.jobs !== undefined) {
    const jobPolicy = await globalJobPolicy(paths.globalConfigPath);
    jobs = new HeavyJobQueue({
      store: stateStore.jobs,
      scope: queueScope!,
      supervisor, logs, maxConcurrent: jobPolicy.max_concurrent_heavy ?? 1, onError,
      ...(jobPolicy.memory === undefined ? {} : { memory: {
        budgetBytes: jobPolicy.memory.budget_mib * 1024 * 1024,
        reserveBytes: (jobPolicy.memory.reserve_mib ?? 1024) * 1024 * 1024,
      } }),
      inspectGroup: async (pgid) => await platformRuntime.process.inspectProcessGroup(pgid),
      resolveTask: async (cwd, taskName) => resolveHeavyJob(stateStore, paths.globalConfigPath, cwd, taskName),
    });
  }
  const proxyPolicy = await globalProxyPolicy(paths.globalConfigPath);
  // The dev overlay (todo item 46, W10-4) is only ever consulted when the proxy itself starts:
  // reading it unconditionally, but wiring it into `ProxyServer` only inside this branch, is what
  // makes `[dev-overlay] enabled = true` with `[proxy]` off inert rather than an error — there is
  // no proxy response path here to inject into.
  const devOverlayPolicy = proxyPolicy.enabled === true
    ? await globalDevOverlayPolicy(paths.globalConfigPath)
    : {};
  // Whether the overlay needs wiring into the proxy at all: the table-level default is on, or a
  // repository opted in on its own via `[dev-overlay.repos.<name>].enabled = true` while the
  // default is off. Checking only `devOverlayPolicy.enabled` here would make that per-repo opt-in
  // silently inert — `isDevOverlayEnabledForRepo` would never even run, because `htmlInjector`
  // itself would never be constructed and handed to `ProxyServer`.
  const devOverlayActive = devOverlayPolicy.enabled === true
    || Object.values(devOverlayPolicy.repos ?? {}).some((repo) => repo?.enabled === true);
  // The checklist's browser-facing toggle endpoint (todo item 46b, W11-1) is wired in behind the
  // same aggregate gate `htmlInjector` above uses — there is no second config flag for this half
  // of the overlay, since a checklist with no overlay to render it in has nothing to toggle from.
  // `checklistApiHandler` itself re-checks `isDevOverlayEnabledForRepo` per request, the same way
  // `devOverlayHtmlInjector` does, so a repository opted out via `[dev-overlay.repos.<name>]` stays
  // opted out even while the aggregate is `true` for some other repository on this shared proxy.
  const proxy = proxyPolicy.enabled === true ? new ProxyServer({
    port: proxyPolicy.port ?? defaultProxyPort,
    resolveRoute: (hostname) => buildProxyRoutes(stateStore).get(hostname) ?? null,
    ...(options.proxyHosts === undefined ? {} : { hosts: options.proxyHosts }),
    onError,
    ...(devOverlayActive ? { htmlInjector: devOverlayHtmlInjector(stateStore, devOverlayPolicy) } : {}),
    ...(devOverlayActive && stateStore.checklist !== undefined
      ? { overlayApi: checklistApiHandler(stateStore.checklist, stateStore, devOverlayPolicy) } : {}),
  }) : null;
  const taskOverrides = stateStore.taskOverrides === undefined ? null : new TaskOverridesHandler({
    store: stateStore.taskOverrides,
    registration: stateStore,
  });
  const checklist = stateStore.checklist === undefined ? null : new ChecklistHandler({
    store: stateStore.checklist,
    registration: stateStore,
  });
  const ci = stateStore.ci === undefined ? null : new CiWatcher({
    store: stateStore.ci,
    registration: stateStore,
    // Same reason as `useGitExecutableResolver` above: `createGhRunner`'s bare `'gh'` default is
    // invisible to a bare-name `spawn` on win32 if `gh` is shadowed by a non-`.exe`/`.com`
    // wrapper earlier on `PATH`, which is exactly what `ci-watch-scenario.test.ts`'s fixture does.
    provider: createGitHubProvider(createGhRunner({
      executable: executablePathResolverFor(platformRuntime.id)('gh'),
    })),
    onError,
  });
  const daemon = new WtmDaemon({
    stateStore,
    socketPath: paths.socketPath,
    processSupervisor: {
      recover: async () => supervisor.recover(),
      close: async () => { await idle.close(); await proxy?.close(); await ci?.close(); await jobs?.close(); await supervisor.close(); },
    },
    runtimeHandler: async (request, context) => (
      ciCommandNames.has(request.command) && ci !== null ? ci.handle(request)
        : jobCommandNames.has(request.command) && jobs !== null ? jobs.handle(request)
          : taskOverrideCommandNames.has(request.command) && taskOverrides !== null ? taskOverrides.handle(request)
            : checklistCommandNames.has(request.command) && checklist !== null ? checklist.handle(request)
              : controller.handle(request, context)
    ),
    // Preparation and lifecycle events belong to the pass that noticed the change, so a
    // worktree created while WTM is watching is prepared before anybody runs anything in it.
    onReconciled: async ({ repository, result }) => {
      try {
        await events.onReconciled(repository, result);
      } catch (error) {
        onError(error);
      }
    },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  let closed = false;
  return {
    paths,
    stateStore,
    logs,
    supervisor,
    controller,
    idle,
    daemon,
    jobs,
    ci,
    taskOverrides,
    checklist,
    proxy,
    start: async () => { await daemon.start(); await jobs?.start(); await ci?.start(); idle.start(); await proxy?.start(); },
    close: async () => {
      if (closed) return;
      closed = true;
      try { await daemon.close(); }
      finally { if (ownedStore) (stateStore as SQLiteStateStore).close(); }
    },
  };
}

async function globalJobPolicy(path: string): Promise<NonNullable<WtmConfig['jobs']>> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseWtmConfig(parse(value), path).jobs ?? {};
}

/**
 * The `[budgets]` admission limits (todo item 19), read from the same global configuration file
 * `[jobs]` and `[proxy]` are: process/host-memory limits are daemon-wide facts about the one
 * machine, not per-workspace settings. See `docs/07`'s "Resource budgets" section.
 */
async function globalBudgetsPolicy(path: string): Promise<NonNullable<WtmConfig['budgets']>> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseWtmConfig(parse(value), path).budgets ?? {};
}

/**
 * The idle windows declared for one worktree's tasks, read straight from the configuration files
 * in force there — plus any `wtm task set` override for that worktree, layered the same way
 * `task-resolution.ts` layers it for a real start/restart. `applyTaskOverrides` replaces a
 * task's whole definition, per its own contract, so an override with no `idle` block (the wire
 * schema has no such field — an override cannot carry one) correctly clears any idle policy the
 * file configuration declared for that task name, rather than leaving the sweep to suspend a task
 * whose overridden definition the rest of WTM no longer treats as the file's own.
 *
 * Deliberately not `resolveWorktreeRuntime`: that also resolves endpoints, adapters and
 * templates, none of which an idle duration depends on, and it runs on every sweep for every
 * worktree that has a managed task running. A worktree WTM no longer has on record has no
 * policies rather than an error — it is about to disappear from the sweep's own listing anyway.
 */
export async function readIdlePolicies(
  store: DaemonStateStore,
  globalConfigPath: string,
  worktreeId: string,
): Promise<ReadonlyMap<string, IdlePolicy>> {
  const worktree = store.listWorktrees().find(({ id }) => id === worktreeId);
  if (worktree === undefined) return new Map();
  const registration = findRegistration(store, worktree.path);
  const config = await resolveWorkspaceConfig({
    workspaceRoot: registration.workspace.root,
    repoRoot: registration.worktree.path,
    globalConfigPath,
  });
  const overrides = store.taskOverrides?.listForWorktree(worktreeId) ?? [];
  const withOverrides = applyTaskOverrides(
    config,
    Object.fromEntries(overrides.map((override) => [override.taskName, override.task])),
  );
  return idlePolicies(withOverrides.value);
}

async function resolveHeavyJob(store: DaemonStateStore, globalConfigPath: string, cwd: string, taskName: string): Promise<ResolvedHeavyJob> {
  const runtime = await resolveWorktreeRuntime({ store, globalConfigPath, cwd, allocate: false });
  const configured = runtime.config.tasks?.[taskName];
  const timeoutMs = queueTaskTimeoutMs(configured?.timeout);
  if (configured?.queue !== true || configured.background === true || timeoutMs === null) {
    throw new HeavyJobError('WTM_JOB_NOT_QUEUEABLE', 'Queue tasks require queue=true, a finite timeout, and background=false.', { taskName });
  }
  const task = resolveTask({ ...taskResolutionInput(runtime, taskName), executionMode: 'queued' });
  const root = await realpath(runtime.registration.worktree.path);
  const taskCwd = await realpath(task.cwd);
  if (!containsPath(root, taskCwd)) throw new HeavyJobError('WTM_JOB_NOT_QUEUEABLE', 'Queued task working directory must stay inside its worktree.', { taskName });
  return {
    workspaceId: runtime.registration.workspace.id, repositoryId: runtime.registration.repository.id,
    worktreeId: runtime.registration.worktree.id, worktreePath: runtime.registration.worktree.path,
    taskName, timeoutMs, argv: task.argv, cwd: taskCwd, shell: task.shell,
    memoryEstimateBytes: configured.memory_estimate_mib === undefined ? null : configured.memory_estimate_mib * 1024 * 1024,
    env: { ...process.env, ...task.envDelta },
  };
}

class ProductionRuntimeResolver implements DaemonRuntimeResolver {
  constructor(
    private readonly store: DaemonStateStore,
    private readonly globalConfigPath: string,
    private readonly onPrepared: (worktreeId: string) => void = () => {},
    /**
     * The policy resource preparation is authorized against.
     *
     * Required, not optional: this class is private to this file and has exactly one construction
     * site, the factory above, which is the composition root that has already chosen a platform.
     * Making the parameter optional would let a future second call site silently fall back to a
     * policy selected somewhere else, which is the drift this seam exists to remove; a type error
     * is the cheaper way to find that out.
     */
    private readonly fileTrust: FileTrustPolicy,
  ) {}

  async resolveTask(cwd: string, taskName: string) {
    const runtime = await this.#runtime(cwd);
    // A task that reads `.env` needs `.env` to be there. Under `[prepare] mode = "lazy"`, the
    // default, this is the moment the worktree is prepared; `eager` will already have done it
    // at discovery, and preparing again creates nothing that is already there.
    await prepareRuntimeResources(runtime, this.fileTrust);
    this.onPrepared(runtime.registration.worktree.id);
    return {
      workspaceId: runtime.registration.workspace.id,
      worktreeId: runtime.registration.worktree.id,
      task: resolveTask(taskResolutionInput(runtime, taskName)),
    };
  }

  async resolveWorktree(cwd: string) {
    const registration = findRegistration(this.store, cwd);
    const repositoryIds = new Set(this.store.listRepositories(registration.workspace.id).map(({ id }) => id));
    return {
      workspaceId: registration.workspace.id,
      worktreeId: registration.worktree.id,
      workspaceWorktreeIds: this.store.listWorktrees()
        .filter(({ repositoryId }) => repositoryIds.has(repositoryId))
        .map(({ id }) => id),
    };
  }

  async resolveExec(cwd: string) {
    const runtime = await this.#runtime(cwd);
    // Raw argv runs in the same worktree a task would, so it finds the same resources.
    await prepareRuntimeResources(runtime, this.fileTrust);
    this.onPrepared(runtime.registration.worktree.id);
    return {
      cwd: runtime.registration.worktree.path,
      envDelta: execEnvironment(runtime),
    };
  }

  async #runtime(cwd: string) {
    return await resolveWorktreeRuntime({
      store: this.store,
      cwd,
      globalConfigPath: this.globalConfigPath,
    });
  }
}
