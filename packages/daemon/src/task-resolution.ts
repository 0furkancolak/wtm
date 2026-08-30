import { basename, relative, resolve, sep } from 'node:path';
import {
  resolveCors,
  resolveEndpoints,
  resolveEnvironment,
  resolveWorkspaceConfig,
  type DaemonStateStore,
  type EndpointAvailabilityProbe,
  type RepositoryRecord,
  type ResolvedEndpoints,
  type StateRegistrationReader,
  type TaskResolutionInput,
  type TemplateContext,
  type WorkspaceRecord,
  type WorktreeRecord,
  type WtmConfig,
} from '@wtm/core';
import type { AdapterContext } from '@wtm/protocol';
import { withAdapterTasks } from './adapter-tasks';
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
  endpoints: ResolvedEndpoints;
}

export interface WorktreeRuntimeInput {
  store: DaemonStateStore;
  cwd: string;
  globalConfigPath: string;
  probe?: EndpointAvailabilityProbe;
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
  const endpoints = resolveEndpoints(input.store, {
    ...(config.value.ports === undefined ? {} : { ports: config.value.ports }),
    worktreeId: owner.id,
    groupWorktreeIds: group.map(({ id }) => id),
    index: owner.numericId,
  }, input.probe);
  const cors = await resolveCors({
    ...(config.value.cors === undefined ? {} : { cors: config.value.cors }),
    root: registration.worktree.path,
    origins: endpoints.origins,
  });

  return {
    registration,
    config: await withAdapterTasks(config.value, adapterContext(registration)),
    context: templateContext(registration, endpoints, cors.value),
    automaticEnvironment: {
      ...endpoints.env,
      ...Object.fromEntries(cors.variables.map((name) => [name, cors.value])),
    },
    endpoints,
  };
}

/** The task resolution the CLI and the daemon both hand to `resolveTask`. */
export function taskResolutionInput(runtime: WorktreeRuntime, taskName: string): TaskResolutionInput {
  return {
    config: runtime.config,
    taskName,
    isMain: runtime.registration.worktree.isMain,
    context: runtime.context,
    automaticEnvironment: runtime.automaticEnvironment,
  };
}

/** The environment a raw `wtm exec` argv runs in: the workspace's, without any task's own. */
export function execEnvironment(runtime: WorktreeRuntime): Record<string, string> {
  return resolveEnvironment({
    automatic: runtime.automaticEnvironment,
    ...(runtime.config.environment === undefined ? {} : { workspace: runtime.config.environment }),
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
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function findRegistration(store: StateRegistrationReader, cwd: string): Registration {
  const absolute = resolve(cwd);
  const worktree = store.listWorktrees()
    .filter((candidate) => contains(candidate.path, absolute))
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
    repository: { root: worktree.path, mainRoot: repository.mainRoot },
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

function contains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..');
}
