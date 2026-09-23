import { basename, resolve } from 'node:path';
import {
  applyTaskOverrides,
  canonicalProxyHostname,
  containsPath,
  defaultOriginHost,
  inspectResources,
  prepareResources,
  repoEnvironment,
  resolveCors,
  resolveEndpoints,
  resolveEnvironment,
  resolveExistingEndpoints,
  resolveWorkspaceConfig,
  type DaemonStateStore,
  type EndpointAvailabilityProbe,
  type ObservedEndpoint,
  type PreparedResource,
  type Provenance,
  type RepositoryRecord,
  type ResolvedEndpoints,
  type StateRegistrationReader,
  type TaskResolutionInput,
  type TemplateContext,
  type WorkspaceRecord,
  type WorktreeRecord,
  type WorktreeState,
  type WtmConfig,
} from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { AdapterContext } from '@wtm/protocol';
import { withAdapterTasks } from './adapter-tasks';
import { defaultProxyPort } from './proxy';
import { globalProxyPolicy } from './proxy-policy';
import { DaemonRegistrationError } from './runtime-controller';

export interface Registration {
  workspace: WorkspaceRecord;
  repository: RepositoryRecord;
  worktree: WorktreeRecord;
}

export interface WorktreeRuntime {
  registration: Registration;
  /** The workspace configuration with the detected adapters' tasks layered underneath it. */
  config: WtmConfig;
  context: TemplateContext;
  /** Endpoint ports and the CORS allowlist, as variables, beneath the workspace's own block. */
  automaticEnvironment: Record<string, string>;
  /** The `[repos.<name>.environment]` of the repository this worktree belongs to, if any. */
  repoEnvironment?: Record<string, string>;
  endpoints: ResolvedEndpoints;
  /**
   * Which file, and which line of it, each configuration key came from. `wtm explain` exists
   * to answer that, and the answer was being resolved and then thrown away.
   */
  provenance: Map<string, Provenance>;
  /**
   * Every declared endpoint and whether a lease backs it. Only present when the runtime was
   * resolved without allocating, which is the only case where "no port yet" can be observed.
   */
  observedEndpoints?: ObservedEndpoint[];
}

export interface WorktreeRuntimeInput {
  store: DaemonStateStore;
  cwd: string;
  globalConfigPath: string;
  probe?: EndpointAvailabilityProbe;
  /**
   * Whether resolving may take a port for an endpoint that has none. True everywhere something
   * is about to run. `wtm plan` sets it false, because a question must not be answered by
   * making its answer untrue.
   */
  allocate?: boolean;
}

/**
 * Everything needed to run something in the worktree that contains `cwd`: which worktree that
 * is, the configuration in force there, and the values its templates resolve against.
 *
 * There is one of these rather than one per entry point because a task must mean the same
 * thing however it is reached. `wtm run` and `wtm start` used to build their own answers, and
 * disagreed about which directory the workspace configuration lived in — so a workspace-level
 * `wtm.toml` applied to supervised tasks and was invisible to foreground ones.
 */
export async function resolveWorktreeRuntime(input: WorktreeRuntimeInput): Promise<WorktreeRuntime> {
  const registration = findRegistration(input.store, input.cwd);
  const config = await resolveWorkspaceConfig({
    workspaceRoot: registration.workspace.root,
    repoRoot: registration.worktree.path,
    globalConfigPath: input.globalConfigPath,
  });
  const group = featureGroup(input.store, registration);
  const owner = group[0] ?? registration.worktree;
  const observed = input.allocate === false
    ? resolveExistingEndpoints(input.store, {
      ...(config.value.ports === undefined ? {} : { ports: config.value.ports }),
      groupWorktreeIds: group.map(({ id }) => id),
    })
    : undefined;
  const endpoints = observed?.resolved ?? resolveEndpoints(input.store, {
    ...(config.value.ports === undefined ? {} : { ports: config.value.ports }),
    worktreeId: owner.id,
    groupWorktreeIds: group.map(({ id }) => id),
    index: owner.numericId,
  }, input.probe);
  const proxyPolicy = await globalProxyPolicy(input.globalConfigPath);
  const cors = await resolveCors({
    ...(config.value.cors === undefined ? {} : { cors: config.value.cors }),
    root: registration.worktree.path,
    origins: proxyPolicy.enabled === true
      ? [...endpoints.origins, ...proxyHostnameOrigins(endpoints, group, proxyPolicy.port ?? defaultProxyPort)]
      : endpoints.origins,
  });

  const repo = repoEnvironment(config.value, {
    workspaceRoot: registration.workspace.root,
    repoRoot: registration.repository.mainRoot,
  });

  const withAdapters = await withAdapterTasks(config.value, adapterContext(registration));
  // `wtm task set` records win over both the file configuration and any adapter-derived task of
  // the same name, so they are layered last.
  const overrides = input.store.taskOverrides?.listForWorktree(registration.worktree.id) ?? [];
  const resolved = applyTaskOverrides(
    { value: withAdapters, provenance: config.provenance },
    Object.fromEntries(overrides.map((override) => [override.taskName, override.task])),
  );

  return {
    registration,
    config: resolved.value,
    context: templateContext(registration, endpoints, cors.value),
    automaticEnvironment: {
      ...endpoints.env,
      ...Object.fromEntries(cors.variables.map((name) => [name, cors.value])),
    },
    endpoints,
    provenance: resolved.provenance,
    ...(observed === undefined ? {} : { observedEndpoints: observed.endpoints }),
    ...(repo === undefined ? {} : { repoEnvironment: repo }),
  };
}

/**
 * The trust policy resource preparation is authorized against, for a caller who injects none.
 *
 * Identical in intent to `logs.ts`'s `hostFileTrustPolicy` and resolved on the same first use, for
 * the same reason: a module-level `selectPlatformRuntime()` would make merely importing the
 * daemon's barrel throw on a platform WTM has no backend for. It matters here because
 * `prepareResources` otherwise falls back to `@wtm/core`'s POSIX-only policy, which reads a
 * Windows directory's synthesised `0o777` mode as "group- or world-writable" and refuses to
 * materialize anything at all.
 */
let selectedFileTrust: FileTrustPolicy | null = null;
function hostFileTrustPolicy(): FileTrustPolicy {
  return (selectedFileTrust ??= selectPlatformRuntime().fileTrust);
}

/**
 * Create whatever the workspace's `[resources]` table says this worktree should have and does
 * not. Called before a task runs, so that a task which reads `.env` finds one.
 */
export async function prepareRuntimeResources(
  runtime: WorktreeRuntime,
  fileTrust: FileTrustPolicy = hostFileTrustPolicy(),
): Promise<PreparedResource[]> {
  const resources = runtime.config.resources;
  if (resources === undefined) return [];
  return await prepareResources({
    resources,
    context: runtime.context,
    worktreeRoot: runtime.registration.worktree.path,
    workspaceRoot: runtime.registration.workspace.root,
    fileTrust,
  });
}

/** The same declarations, observed rather than acted on, for `wtm status`. */
export async function inspectRuntimeResources(runtime: WorktreeRuntime): Promise<PreparedResource[]> {
  const resources = runtime.config.resources;
  if (resources === undefined) return [];
  return await inspectResources({
    resources,
    context: runtime.context,
    worktreeRoot: runtime.registration.worktree.path,
  });
}


/** The task resolution the CLI and the daemon both hand to `resolveTask`. */
export function taskResolutionInput(runtime: WorktreeRuntime, taskName: string): TaskResolutionInput {
  return {
    config: runtime.config,
    taskName,
    isMain: runtime.registration.worktree.isMain,
    context: runtime.context,
    automaticEnvironment: runtime.automaticEnvironment,
    ...(runtime.repoEnvironment === undefined ? {} : { repoEnvironment: runtime.repoEnvironment }),
  };
}

/** The environment a raw `wtm exec` argv runs in: the workspace's, without any task's own. */
export function execEnvironment(runtime: WorktreeRuntime): Record<string, string> {
  return resolveEnvironment({
    automatic: runtime.automaticEnvironment,
    ...(runtime.config.environment === undefined ? {} : { workspace: runtime.config.environment }),
    ...(runtime.repoEnvironment === undefined ? {} : { repo: runtime.repoEnvironment }),
    context: runtime.context,
  });
}

/**
 * Every worktree of this workspace on the same branch, across every repository, ordered so
 * that the answer does not depend on who asked. A feature branch checked out in the API
 * repository and the web repository is one feature, and its endpoints are allocated once for
 * the whole of it — otherwise the web app cannot be told the API's port.
 */
export function featureGroup(store: StateRegistrationReader, registration: Registration): WorktreeRecord[] {
  const branch = registration.worktree.branch;
  if (branch === null) return [registration.worktree];
  const repositories = new Set(store.listRepositories(registration.workspace.id).map(({ id }) => id));
  return store.listWorktrees()
    .filter((worktree) => repositories.has(worktree.repositoryId) && worktree.branch === branch)
    // A worktree Git no longer reports, or that is mid-teardown, is not a candidate to hold the
    // group's shared endpoint leases going forward -- reconciliation and removal both already
    // release its own leases (see `reconcileWorktrees`/`releaseEndpointLeases`), and leaving it
    // eligible here would keep every future resolution attaching new leases to a worktree that
    // is gone. The registration's own worktree is always kept: a caller resolving against it is
    // free to be in any state itself.
    .filter((worktree) => worktree.id === registration.worktree.id || !deadWorktreeStates.has(worktree.state))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Worktree states that mean "gone or going" -- Git no longer reports it, or something else
 * already owns tearing it down. Shared between `featureGroup` (endpoint-lease ownership) and
 * `proxy-routes.ts`'s hostname-slug assignment: both need "every worktree that could still claim
 * this identity" rather than "every worktree that happens to be active right now."
 */
export const deadWorktreeStates = new Set<WorktreeState>(['ORPHANED', 'CLEANING', 'REMOVED', 'DEGRADED_CLEANUP']);

/**
 * The proxy-hostname origins for the endpoints that already publish a dynamic-port origin, when
 * `[proxy] enabled = true` (todo item 12b's other half, W10-1).
 *
 * This deliberately walks `endpoints.leases` rather than `[ports]` itself: a fixed-port endpoint
 * has no lease and the proxy's own routing table (`proxy-routes.ts`'s `buildProxyRoutes`) is
 * built purely from active leases, so a fixed port is never reachable through the proxy and must
 * not get a proxy-hostname origin here either. Within the leased endpoints, only the ones that
 * already contributed a `http://<host>:<port>` origin above are extended — an endpoint whose own
 * `[ports.<name>] origin = false` opted out of a browser origin entirely, and this must not hand
 * it one back through the proxy's side door. The correlation is by port rather than by name,
 * because `endpoints.leases` (unlike `endpoints.origins`) is not filtered by that opt-out and
 * carries no origin flag of its own — matching on the origin string `resolveEndpoints` already
 * built is what keeps this the *same* set, not a superset or subset of it.
 */
function proxyHostnameOrigins(
  endpoints: ResolvedEndpoints,
  group: readonly WorktreeRecord[],
  proxyPort: number,
): string[] {
  if (endpoints.leases.length === 0) return [];
  const worktreesById = new Map(group.map((worktree) => [worktree.id, worktree] as const));
  const origins: string[] = [];
  for (const lease of endpoints.leases) {
    if (!endpoints.origins.includes(`http://${defaultOriginHost}:${lease.port}`)) continue;
    const worktree = worktreesById.get(lease.worktreeId);
    // Every lease resolved here was looked up within `group`'s own worktree ids
    // (`resolveEndpoints`'s `groupWorktreeIds`), so this is defensive rather than expected.
    if (worktree === undefined) continue;
    origins.push(`http://${canonicalProxyHostname(worktree, lease.name, group)}:${proxyPort}`);
  }
  return origins;
}

export function findRegistration(store: StateRegistrationReader, cwd: string): Registration {
  const absolute = resolve(cwd);
  const worktree = store.listWorktrees()
    .filter((candidate) => containsPath(candidate.path, absolute))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (worktree === undefined) {
    throw new DaemonRegistrationError(
      'This directory is not inside a worktree WTM has registered. Run `wtm init` in the workspace root.',
    );
  }
  const repository = store.listRepositories().find(({ id }) => id === worktree.repositoryId);
  if (repository === undefined) {
    throw new DaemonRegistrationError('The registered worktree has no repository on record.');
  }
  const workspace = store.listWorkspaces().find(({ id }) => id === repository.workspaceId);
  if (workspace === undefined) {
    throw new DaemonRegistrationError('The registered repository has no workspace on record.');
  }
  return { workspace, repository, worktree };
}

export function adapterContext({ workspace, repository, worktree }: Registration): AdapterContext {
  return {
    workspace: { root: workspace.root },
    repository: { root: repository.mainRoot, mainRoot: repository.mainRoot },
    worktree: { root: worktree.path, id: worktree.numericId, branch: worktree.branch ?? null },
  };
}

export function templateContext(
  { workspace, repository, worktree }: Registration,
  endpoints: ResolvedEndpoints = { ports: {}, env: {}, origins: [], leases: [] },
  corsOrigins = '',
): TemplateContext {
  const branch = branchName(worktree.branch);
  return {
    workspace: { root: workspace.root, name: workspace.name },
    repo: { root: worktree.path, name: basename(repository.mainRoot) },
    main: { root: repository.mainRoot },
    worktree: { root: worktree.path },
    id: worktree.numericId,
    key: String(worktree.numericId),
    slug: basename(worktree.path),
    branch,
    branchSlug: branch.replace(/[^A-Za-z0-9._-]+/g, '-'),
    ports: endpoints.ports,
    cors: { origins: corsOrigins },
    env: process.env,
  };
}

/**
 * `{branch}` is the name a person types — `feat/login`, not `refs/heads/feat/login`. Git
 * reports the fully qualified ref, and the two entry points used to disagree about which of
 * them the template meant.
 */
export function branchName(ref: string | null): string {
  return ref === null ? '' : ref.replace(/^refs\/heads\//, '');
}
