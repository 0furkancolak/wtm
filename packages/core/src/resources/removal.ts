import { lstat, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ResourceConfig } from '../config/schema';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../file-trust-policy';
import { runGit } from '../git/git-runner';
import { resolveTemplate, type TemplateContext } from '../templates/resolve';
import { ResourcePathGuardError } from './guard';

export type WorktreeResourceDisposition = 'deleted' | 'already-absent' | 'retained';

export interface WorktreeResourceOutcome {
  name: string;
  path: string;
  policy: string;
  disposition: WorktreeResourceDisposition;
  /** Why it was retained; absent for anything WTM acted on. */
  reason?: string | undefined;
}

export interface WorktreeResourceCleanupResult {
  /** How many paths this run actually deleted; an already-absent target is not one of them. */
  collected: number;
  outcomes: WorktreeResourceOutcome[];
  retained: { name: string; reason: string }[];
}

export interface WorktreeResourceCleanupInput {
  /** The worktree being removed, and the only directory anything is deleted from. */
  worktreeRoot: string;
  /** The worktree's own resolved `[resources]` table, exactly as `prepareResources` consumes it. */
  resources: Record<string, ResourceConfig>;
  /**
   * The context a templated resource path is rendered against — the same one preparation used.
   * A path this cannot render is retained rather than guessed at.
   */
  context?: TemplateContext;
  fileTrust?: FileTrustPolicy;
}

/**
 * Policies whose object WTM never created, and therefore never deletes. A shared `node_modules`
 * outliving one worktree is the correct outcome, not an omission.
 */
const retainedPolicies = new Set<ResourceConfig['policy']>(['shared', 'native-cache', 'external', 'ignore']);
/**
 * Policies whose object WTM materialized inside the worktree, and therefore owns.
 *
 * The design also names `generated`, which the configuration schema does not define today; it is
 * absent here rather than cast in, and anything not listed is retained, so a policy added later
 * is not deleted by a rule written before it existed.
 */
const ownedPolicies = new Set<ResourceConfig['policy']>(['isolated', 'ephemeral', 'clone', 'copy', 'symlink']);

interface PathIdentity {
  dev: number;
  ino: number;
  uid: number;
}

type CleanupStep =
  | { kind: 'settled'; outcome: WorktreeResourceOutcome }
  | { kind: 'delete'; name: string; path: string; policy: string; identity: PathIdentity };

type PlannedTarget =
  | { kind: 'collect'; name: string; path: string; policy: string }
  | { kind: 'retain'; name: string; path: string; policy: string; reason: string };

/**
 * Delete what WTM itself materialized inside this worktree, so Git can remove it.
 *
 * A `[resources]` entry with policy `isolated` or `ephemeral` is a directory WTM created in the
 * worktree, and to Git that is untracked content — a removal blocker. So a worktree that ever ran
 * a task cannot be removed until this runs. This is not the `gc` path and cannot be: a Git working
 * tree is deliberately never a resource sandbox and its resources carry no lifecycle record at all
 * (`packages/cli/src/commands/resource-production.ts:41-48`), so there is nothing journalled to
 * collect. The declarations are the evidence.
 *
 * Every target is authorized before anything is deleted, with the same rules `preparation.ts`
 * applies when it creates these paths: a path WTM refused to create is a path it must refuse to
 * delete. A refusal aborts the whole run, so a removal never proceeds over a half-cleaned worktree.
 * A target that is already gone is a success, because `--resume` re-runs this stage.
 */
export async function cleanupWorktreeEphemeralResources(
  input: WorktreeResourceCleanupInput,
): Promise<WorktreeResourceCleanupResult> {
  const worktreeRoot = resolve(input.worktreeRoot);
  const fileTrust = input.fileTrust ?? defaultCoreFileTrustPolicy;
  const steps: CleanupStep[] = [];

  // Everything is authorized first, and only then is anything deleted: a refusal at the last
  // declaration must not leave the ones before it already collected.
  for (const planned of plannedTargets(input, worktreeRoot)) {
    const { name, path, policy } = planned;
    if (planned.kind === 'retain') {
      steps.push({ kind: 'settled', outcome: retained(name, path, policy, planned.reason) });
      continue;
    }

    await authorizeTarget(name, path, worktreeRoot, fileTrust);
    const identity = await identityOf(path);
    steps.push(identity === null
      ? { kind: 'settled', outcome: { name, path, policy, disposition: 'already-absent' } }
      : { kind: 'delete', name, path, policy, identity });
  }

  const outcomes: WorktreeResourceOutcome[] = [];
  for (const step of steps) {
    if (step.kind === 'settled') {
      outcomes.push(step.outcome);
      continue;
    }
    outcomes.push({
      name: step.name,
      path: step.path,
      policy: step.policy,
      disposition: await deleteTarget(step),
    });
  }

  return {
    collected: outcomes.filter((outcome) => outcome.disposition === 'deleted').length,
    outcomes,
    retained: outcomes
      .filter((outcome) => outcome.disposition === 'retained')
      .map((outcome) => ({ name: outcome.name, reason: outcome.reason ?? outcome.policy })),
  };
}

/**
 * The absolute paths inside this worktree that {@link cleanupWorktreeEphemeralResources} would
 * delete, in declaration order.
 *
 * The removal lifecycle asks for these *before* its first safety gate, because a `GIT_UNTRACKED`
 * blocker naming only these paths is not work anyone would lose — it is the reason the cleanup
 * stage exists, and refusing in front of that stage is how the stage became unreachable. Only
 * the same answer is trustworthy there: a path this reported and cleanup then declined to delete
 * would be a deferral that never gets collected, which is why both read one plan rather than two
 * copies of the policy set.
 *
 * A declaration whose path cannot be rendered is left out. WTM could not have created a path it
 * cannot compute, and omitting it makes the removal refuse, which is the safe direction.
 */
export function reclaimableWorktreeResourcePaths(input: WorktreeResourceCleanupInput): string[] {
  return plannedTargets(input, resolve(input.worktreeRoot))
    .filter((planned) => planned.kind === 'collect')
    .map((planned) => planned.path);
}

/**
 * What each declaration resolves to before anything touches the filesystem: a path this run owns
 * and would delete, or the reason it is left alone. Deciding this without acting on it is what
 * lets the lifecycle ask the question ahead of the deletion.
 */
function plannedTargets(input: WorktreeResourceCleanupInput, worktreeRoot: string): PlannedTarget[] {
  return entriesOf(input.resources).map(([name, config]) => {
    let path;
    try {
      path = targetPath(config, worktreeRoot, input.context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'retain', name, path: config.path, policy: config.policy, reason };
    }
    return !ownedPolicies.has(config.policy) || retainedPolicies.has(config.policy)
      ? { kind: 'retain', name, path, policy: config.policy, reason: config.policy }
      : { kind: 'collect', name, path, policy: config.policy };
  });
}

async function deleteTarget(step: Extract<CleanupStep, { kind: 'delete' }>): Promise<WorktreeResourceDisposition> {
  // The decision was made against an inode; act on the same one or not at all.
  let entry;
  try {
    entry = await lstat(step.path);
  } catch {
    // It went away between the decision and the deletion. Deleting nothing is the outcome asked
    // for, so this is the idempotent success, not a race worth failing over.
    return 'already-absent';
  }
  if (!sameIdentity(entry, step.identity)) {
    throw new ResourcePathGuardError(
      'RESOURCE_PATH_DENIED',
      'A resource changed identity after it was authorized for deletion.',
      { name: step.name, path: step.path, policy: step.policy },
    );
  }
  // A symbolic link is removed as the link it is. Following it would delete a file that belongs
  // to whatever the link points at — routinely the main working tree.
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await unlink(step.path);
    return 'deleted';
  }
  await rm(step.path, { recursive: true, force: true });
  return 'deleted';
}

/**
 * Refuse to delete anything WTM would have refused to create.
 *
 * This mirrors `refuseTarget` in `packages/core/src/resources/preparation.ts:144-166`, which is the
 * authority for these rules; it is restated here because that helper is private to preparation and
 * this module must not reach into it. The two must stay in step: they are the same authorization,
 * once for creating a path and once for deleting it.
 */
async function authorizeTarget(
  name: string,
  path: string,
  worktreeRoot: string,
  fileTrust: FileTrustPolicy,
): Promise<void> {
  const context = { name, path, worktreeRoot };
  const within = relative(worktreeRoot, path);
  if (within.length === 0 || within.startsWith('..') || isAbsolute(within)) {
    deny('A resource path has to name something inside its own worktree.', context);
  }
  if (within.split(sep).includes('.git')) deny('Git administrative paths are protected.', context);

  for (const directory of ancestors(worktreeRoot, dirname(path))) {
    let entry;
    try {
      entry = await lstat(directory);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) {
      deny(`${directory} is a symbolic link, so WTM will not delete through it.`, context);
    }
    if (!entry.isDirectory()) deny(`${directory} is not a directory.`, context);
    // Unavailable identity is skipped, not denied — the same asymmetry `preparation.ts`'s
    // `refuseTarget` preserves, because the two are "the same authorization" (this function's own
    // doc comment) and must not silently diverge on this call site alone.
    if (fileTrust.currentIdentityAvailable() && !(await fileTrust.isOwnedByCurrentUser(entry, directory))) {
      deny(`${directory} belongs to another user.`, context);
    }
    if (!(await fileTrust.isWritableOnlyByOwner(entry, directory, 0o022))) {
      deny(`${directory} is group- or world-writable.`, context);
    }
  }
  if (await tracked(worktreeRoot, within)) {
    throw new ResourcePathGuardError(
      'RESOURCE_TRACKED_FILE_PROTECTED',
      'Git tracks this path, so WTM will not delete it.',
      { ...context, repositoryRelativePath: within },
    );
  }
}

/** Every directory from the worktree root down to `directory`, the root included. */
function ancestors(worktreeRoot: string, directory: string): string[] {
  const parts = relative(worktreeRoot, directory).split(sep).filter((part) => part.length > 0);
  return parts.reduce<string[]>(
    (paths, part) => [...paths, resolve(paths[paths.length - 1] as string, part)],
    [worktreeRoot],
  );
}

/** Whether Git owns this path; failing closed, because a path Git may own is never WTM's to delete. */
async function tracked(worktreeRoot: string, relativePath: string): Promise<boolean> {
  try {
    const result = await runGit(worktreeRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', relativePath]);
    return result.stdout.length > 0;
  } catch {
    return true;
  }
}

async function identityOf(path: string): Promise<PathIdentity | null> {
  try {
    const entry = await lstat(path);
    return { dev: Number(entry.dev), ino: Number(entry.ino), uid: Number(entry.uid) };
  } catch {
    return null;
  }
}

function sameIdentity(entry: { dev: number; ino: number; uid: number }, expected: PathIdentity): boolean {
  return Number(entry.dev) === expected.dev
    && Number(entry.ino) === expected.ino
    && Number(entry.uid) === expected.uid;
}

function retained(name: string, path: string, policy: string, reason: string): WorktreeResourceOutcome {
  return { name, path, policy, disposition: 'retained', reason };
}

function targetPath(config: ResourceConfig, worktreeRoot: string, context: TemplateContext | undefined): string {
  const rendered = resolveTemplate(config.path, context ?? { worktree: { root: worktreeRoot } });
  return isAbsolute(rendered) ? resolve(rendered) : resolve(worktreeRoot, rendered);
}

function entriesOf(resources: Record<string, ResourceConfig>): Array<[string, ResourceConfig]> {
  return Object.entries(resources).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function deny(message: string, context: Record<string, unknown>): never {
  throw new ResourcePathGuardError('RESOURCE_PATH_DENIED', message, context);
}
