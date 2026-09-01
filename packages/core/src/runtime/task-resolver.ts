import { parseWtmConfig, WtmConfigError, type WtmConfig } from '../config/schema';
import { resolveTemplate, type TemplateContext } from '../templates/resolve';
import { resolveEnvironment } from './environment';

export interface ResolvedTask {
  argv: string[];
  shell: boolean;
  cwd: string;
  envDelta: Record<string, string>;
  background: boolean;
  singleton: boolean;
}

export interface TaskResolutionInput {
  config: WtmConfig;
  taskName: string;
  isMain: boolean;
  context: TemplateContext;
  /** Variables WTM derived for this worktree — endpoint ports, the CORS allowlist. */
  automaticEnvironment?: Record<string, string>;
  /** The `[repos.<name>.environment]` in force for the repository this worktree belongs to. */
  repoEnvironment?: Record<string, string>;
}

export class WtmTaskResolutionError extends Error {
  readonly code = 'WTM_CONFIG_INVALID' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WtmTaskResolutionError';
    this.context = context;
  }
}

/**
 * How many names the message itself spells out. No command lists tasks — the CLI registers 20
 * and none enumerates them — so this message is the only surface where the information reaches
 * a user, and it is rendered on a single line (`packages/cli/src/output.ts:67`). Ten is more
 * than any `wtm.toml` in `examples/` declares, so a hand-written configuration is never
 * truncated, and it holds that line to roughly 200 characters. Adapters can contribute far
 * more — the `make` adapter alone allows 64 targets — and for those the count stands in for
 * the tail while `context.knownTasks` still carries every name.
 */
const maxListedTasks = 10;

export function resolveTask(input: TaskResolutionInput): ResolvedTask {
  const config = validatedConfig(input);
  const task = config.tasks?.[input.taskName];
  if (task === undefined) {
    // The same object the lookup above missed in, so the list can never name a task that then
    // fails to resolve. Alphabetical rather than ranked: `context` is a contract, and which
    // names a person should read first is a decision about the message, not about the data.
    const knownTasks = Object.keys(config.tasks ?? {}).sort(compareNames);
    throw new WtmTaskResolutionError(unknownTaskMessage(input.taskName, knownTasks), {
      taskName: input.taskName,
      knownTasks,
    });
  }

  const command = task.run ?? (input.isMain ? task.main : task.worktree);
  if (command === undefined) {
    const target = input.isMain ? 'main-worktree' : 'linked-worktree';
    throw new WtmTaskResolutionError(`Task ${input.taskName} does not define a ${target} command.`, {
      taskName: input.taskName,
      target,
    });
  }

  const envDelta = resolveEnvironment({
    ...(input.automaticEnvironment === undefined ? {} : { automatic: input.automaticEnvironment }),
    ...(config.environment === undefined ? {} : { workspace: config.environment }),
    ...(input.repoEnvironment === undefined ? {} : { repo: input.repoEnvironment }),
    ...(task.env === undefined ? {} : { task: task.env }),
    context: input.context,
  });
  const context = {
    ...input.context,
    env: { ...input.context.env, ...envDelta },
  };
  const argv = (typeof command === 'string' ? [command] : command)
    .map((argument) => resolveTemplate(argument, context));
  const rawCwd = task.cwd ?? input.context.worktree?.root;
  if (rawCwd === undefined) {
    throw new WtmTaskResolutionError(`Task ${input.taskName} has no resolvable working directory.`, {
      taskName: input.taskName,
    });
  }

  return {
    argv,
    shell: task.shell === true,
    cwd: resolveTemplate(rawCwd, context),
    envDelta,
    background: task.background ?? false,
    singleton: task.singleton ?? true,
  };
}

/** A TOML bare key. Anything else has to be quoted before it can be suggested as one. */
const bareTomlKey = /^[A-Za-z0-9_-]+$/;

function unknownTaskMessage(taskName: string, knownTasks: string[]): string {
  if (knownTasks.length === 0) {
    // Naming no tasks is not the same failure as naming the wrong one, and the answer is a
    // file to edit rather than a name to correct.
    const key = bareTomlKey.test(taskName) ? taskName : JSON.stringify(taskName);
    return `Unknown task: ${taskName}. This workspace defines no tasks. `
      + `Add a [tasks.${key}] block with a run command to wtm.toml.`;
  }
  const listed = rankByCloseness(knownTasks, taskName).slice(0, maxListedTasks);
  const remaining = knownTasks.length - listed.length;
  const more = remaining === 0 ? '' : ` and ${remaining} more`;
  return `Unknown task: ${taskName}. Known tasks: ${listed.join(', ')}${more}.`;
}

/**
 * The ten names shown are the ten closest to what the user typed, so `wtm resolve dev` in a
 * workspace with a Makefile leads with `make:dev` rather than with whichever target the adapter
 * happened to parse first. Provenance would be the other way to order this, and is unavailable:
 * the adapters' tasks and the workspace's own reach `resolveTask` as one flat table.
 *
 * Three containment tiers ahead of any distance, because a name that literally contains what
 * was typed is a better guess than a distance can express — `make:dev` is the answer to `dev`
 * however many edits separate them. Distance then orders the rest and breaks ties inside a
 * tier, putting `make:dev` ahead of `make:devtools`; the name itself breaks what is left, so
 * the message is identical on every run and does not depend on the table's key order.
 */
function rankByCloseness(names: string[], taskName: string): string[] {
  const target = taskName.toLowerCase();
  return names
    .map((name) => {
      const candidate = name.toLowerCase();
      return { name, tier: matchTier(candidate, target), distance: editDistance(candidate, target) };
    })
    .sort((left, right) => left.tier - right.tier
      || left.distance - right.distance
      || compareNames(left.name, right.name))
    .map(({ name }) => name);
}

function matchTier(candidate: string, target: string): number {
  if (candidate === target) return 0;
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 1;
  if (candidate.includes(target) || target.includes(candidate)) return 2;
  return 3;
}

/**
 * Levenshtein distance, one row at a time. Task names are short and this runs only on the way
 * to an error, so the cost is invisible — and it is not worth a dependency.
 */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substituted = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(substituted, (previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** Code-unit order, which is the same on every machine — `localeCompare` is not. */
function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function validatedConfig(input: TaskResolutionInput): WtmConfig {
  try {
    return parseWtmConfig(input.config);
  } catch (error) {
    if (!(error instanceof WtmConfigError)) throw error;
    const issues = Array.isArray(error.context.issues) ? error.context.issues : [];
    const firstIssue = issues[0];
    const message = typeof firstIssue === 'object'
      && firstIssue !== null
      && 'message' in firstIssue
      && typeof firstIssue.message === 'string'
      ? firstIssue.message
      : error.message;
    throw new WtmTaskResolutionError(message, { ...error.context, taskName: input.taskName });
  }
}
