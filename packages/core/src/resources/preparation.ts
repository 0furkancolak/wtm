import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ResourceConfig } from '../config/schema';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../file-trust-policy';
import { runGit } from '../git/git-runner';
import { resolveTemplate, type TemplateContext } from '../templates/resolve';

export type ResourceState = 'ready' | 'missing' | 'degraded' | 'unknown';

export interface PreparedResource {
  name: string;
  path: string;
  policy: ResourceConfig['policy'];
  state: ResourceState;
  /** Why it is not ready, in the words the person who wrote the table would recognise. */
  detail?: string;
}

export interface ResourcePreparationInput {
  resources: Record<string, ResourceConfig>;
  context: TemplateContext;
  /** The directory a relative resource path is relative to, and the only one written into. */
  worktreeRoot: string;
  /** A source may be read from here, and from nowhere else. */
  workspaceRoot: string;
  fileTrust?: FileTrustPolicy;
}

/** Policies whose object WTM does not own, and therefore never creates. */
const externalPolicies = new Set<ResourceConfig['policy']>(['shared', 'native-cache', 'external', 'ignore']);
/** Policies that name where their content comes from. */
const sourcedPolicies = new Set<ResourceConfig['policy']>(['symlink', 'copy', 'clone']);

/**
 * What each declared resource looks like right now, without touching anything. `wtm status`
 * reported an empty list whatever the configuration said, so a `[resources]` table that had
 * never been acted on was indistinguishable from a workspace that declared none.
 */
export async function inspectResources(
  input: Pick<ResourcePreparationInput, 'resources' | 'context' | 'worktreeRoot'>,
): Promise<PreparedResource[]> {
  const prepared: PreparedResource[] = [];
  for (const [name, config] of entriesOf(input.resources)) {
    let path;
    try {
      path = targetPath(config, input.context, input.worktreeRoot);
    } catch (error) {
      // Observing must not fail where acting would. A path built from `{port.api}` has no
      // answer until something leases that port, and `wtm status` saying so is the report;
      // `wtm status` throwing is not.
      prepared.push({
        name,
        path: config.path,
        policy: config.policy,
        state: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    prepared.push({ name, path, policy: config.policy, ...await observe(path, config) });
  }
  return prepared;
}

/**
 * Create every declared resource this worktree does not have yet. A `[resources]` table used to
 * be accepted by the schema, shown in the reference configuration, and then acted on by nothing
 * at all: a worktree's `.env` was never linked, so every task started without one.
 *
 * The general resource guard cannot do this. It is built for a sandbox that WTM may sweep, and
 * refuses a Git working tree as one — correctly, because `gc` must never walk a repository. A
 * worktree-local resource is the narrower operation of creating one named path that is not
 * there, so it carries its own rules, asserted here and nowhere else:
 *
 * - the target resolves strictly inside this worktree, and names no `.git` component;
 * - no directory on the way to it is a symbolic link, group-writable, or another user's;
 * - Git does not track the target;
 * - the target does not already exist — nothing is ever replaced;
 * - a source is read only from inside the workspace, and only through its real path.
 */
export async function prepareResources(input: ResourcePreparationInput): Promise<PreparedResource[]> {
  const worktreeRoot = resolve(input.worktreeRoot);
  const fileTrust = input.fileTrust ?? defaultCoreFileTrustPolicy;
  const prepared: PreparedResource[] = [];
  for (const [name, config] of entriesOf(input.resources)) {
    const path = targetPath(config, input.context, worktreeRoot);
    prepared.push({
      name, path, policy: config.policy,
      ...await prepareOne(config, path, worktreeRoot, input, fileTrust),
    });
  }
  return prepared;
}

async function prepareOne(
  config: ResourceConfig,
  path: string,
  worktreeRoot: string,
  input: ResourcePreparationInput,
  fileTrust: FileTrustPolicy,
): Promise<{ state: ResourceState; detail?: string }> {
  const observed = await observe(path, config);
  if (externalPolicies.has(config.policy) || observed.state === 'ready') return observed;

  const source = await resolvedSource(config, input, worktreeRoot);
  if (sourcedPolicies.has(config.policy)) {
    if (source.path === null) return degraded(source.detail ?? `A ${config.policy} resource needs a source.`);
    if (source.missing) {
      return config.optional === true
        ? { state: 'missing', detail: `Its source ${source.path} does not exist.` }
        : degraded(`Its source ${source.path} does not exist.`);
    }
  }

  const refusal = await refuseTarget(path, worktreeRoot, fileTrust);
  if (refusal !== null) return degraded(refusal);

  try {
    await create(config, path, source.path);
    return { state: 'ready' };
  } catch (error) {
    return degraded(error instanceof Error ? error.message : String(error));
  }
}

async function create(config: ResourceConfig, path: string, source: string | null): Promise<void> {
  if (config.policy === 'isolated' || config.policy === 'ephemeral') {
    await mkdir(path, { recursive: false, mode: 0o700 });
    return;
  }
  if (config.policy === 'symlink') {
    // `symlink` fails outright when something is already there, which is the guarantee wanted:
    // a resource never replaces a file the worktree already has.
    await symlink(source as string, path);
    return;
  }
  // A copy or a clone is this worktree's own file, so it is staged beside the target and moved
  // into place: an interrupted copy leaves a `.wtm-partial` file, never a half-written resource.
  const staged = `${path}.wtm-partial-${randomUUID().slice(0, 8)}`;
  try {
    await copyFile(source as string, staged);
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

/** Why this path may not be written, or `null` when it may. */
async function refuseTarget(path: string, worktreeRoot: string, fileTrust: FileTrustPolicy): Promise<string | null> {
  const within = relative(worktreeRoot, path);
  if (within.length === 0 || within.startsWith('..') || isAbsolute(within)) {
    return 'A resource path has to name something inside its own worktree.';
  }
  if (within.split(sep).includes('.git')) return 'Git administrative paths are protected.';

  for (const directory of ancestors(worktreeRoot, dirname(path))) {
    let entry;
    try {
      entry = await lstat(directory);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) return `${directory} is a symbolic link, so WTM will not write through it.`;
    if (!entry.isDirectory()) return `${directory} is not a directory.`;
    // Unlike `guard.ts`, an unavailable identity is not refused here — it is treated the same
    // way this check always has been: skipped, not denied. That asymmetry predates this port and
    // is preserved rather than reconciled; the port carries the same comparison, not a new policy.
    if (fileTrust.currentIdentityAvailable() && !(await fileTrust.isOwnedByCurrentUser(entry, directory))) {
      return `${directory} belongs to another user.`;
    }
    if (!(await fileTrust.isWritableOnlyByOwner(entry, directory, 0o022))) {
      return `${directory} is group- or world-writable.`;
    }
  }
  if (await tracked(worktreeRoot, within)) return 'Git tracks this path, so WTM will not write over it.';
  return null;
}

/** Every directory from the worktree root down to `directory`, the root included. */
function ancestors(worktreeRoot: string, directory: string): string[] {
  const parts = relative(worktreeRoot, directory).split(sep).filter((part) => part.length > 0);
  return parts.reduce<string[]>(
    (paths, part) => [...paths, resolve(paths[paths.length - 1] as string, part)],
    [worktreeRoot],
  );
}

/** Whether Git already owns this path; a resource may only ever create what it does not. */
async function tracked(worktreeRoot: string, relativePath: string): Promise<boolean> {
  try {
    const result = await runGit(worktreeRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', relativePath]);
    return result.stdout.length > 0;
  } catch {
    // A directory Git cannot answer for is not one WTM should start writing into.
    return true;
  }
}

async function resolvedSource(
  config: ResourceConfig,
  input: ResourcePreparationInput,
  worktreeRoot: string,
): Promise<{ path: string | null; missing: boolean; detail?: string }> {
  if (config.source === undefined) return { path: null, missing: true };
  const rendered = resolveTemplate(config.source, input.context);
  const requested = isAbsolute(rendered) ? resolve(rendered) : resolve(worktreeRoot, rendered);
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    return { path: requested, missing: true };
  }
  const workspaceRoot = await realpath(input.workspaceRoot).catch(() => resolve(input.workspaceRoot));
  const within = relative(workspaceRoot, real);
  if (within.startsWith('..') || isAbsolute(within)) {
    return { path: null, missing: false, detail: `Its source ${requested} is outside the workspace.` };
  }
  return { path: real, missing: false };
}

async function observe(path: string, config: ResourceConfig): Promise<{ state: ResourceState; detail?: string }> {
  let link;
  try {
    link = await lstat(path);
  } catch {
    return { state: 'missing' };
  }
  if (!link.isSymbolicLink()) return { state: 'ready' };
  if (await exists(path)) return { state: 'ready' };
  return { state: 'degraded', detail: `The ${config.policy} target points at something that is gone.` };
}

function targetPath(config: ResourceConfig, context: TemplateContext, worktreeRoot: string): string {
  const rendered = resolveTemplate(config.path, context);
  return isAbsolute(rendered) ? resolve(rendered) : resolve(worktreeRoot, rendered);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function degraded(detail: string): { state: ResourceState; detail: string } {
  return { state: 'degraded', detail };
}

function entriesOf(resources: Record<string, ResourceConfig>): Array<[string, ResourceConfig]> {
  return Object.entries(resources).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
