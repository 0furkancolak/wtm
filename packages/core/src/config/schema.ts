import { z } from 'zod';
import { normalizeAllowedRemoteRefs } from '../analysis/remote-persistence';
import { idleTimeoutMs, queueTaskTimeoutMs } from './task-timeout';
import { healthcheckSchema } from './healthcheck';
import { idleSchema } from './idle';

/** What an environment variable may be called, and so what `worker_vars` may name. */
export const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/**
 * Field-level shape only, with none of `taskSchema`'s cross-field rules -- used to validate one
 * config *layer* in isolation, before it is merged with the others. A field this shape accepts
 * standing alone may still combine with a sibling from a different layer into something
 * {@link taskSchema}'s `superRefine` rejects (`queue = true` in a workspace file, `queue_env` in
 * a repo's own `.wtm.toml`); that combination is only checked once, on the merged result. See
 * {@link parseWtmConfigLayer}.
 */
const taskShape = z.object({
  description: z.string().min(1).optional(),
  expose: z.boolean().optional(),
  run: commandSchema.optional(),
  main: commandSchema.optional(),
  worktree: commandSchema.optional(),
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  background: z.boolean().optional(),
  healthcheck: healthcheckSchema.optional(),
  idle: idleSchema.optional(),
  queue: z.boolean().optional(),
  memory_estimate_mib: z.number().int().min(1).max(1_048_576).optional(),
  queue_env: z.record(z.string().min(1), z.string()).optional(),
  singleton: z.boolean().optional(),
  grace_period: z.string().min(1).optional(),
  timeout: z.string().min(1).optional(),
  on_failure: z.enum(['fail', 'warn', 'continue']).optional(),
  requires: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Variables of this task's own resolved environment to hand a `wrangler dev` worker as
   * `--var NAME:VALUE`. A worker's `env` is built from wrangler's own configuration `vars` and
   * `.dev.vars`, never from the process environment, so without this a value WTM derived -- a
   * port, the CORS allowlist -- reaches wrangler and stops there.
   */
  worker_vars: z.array(z.string().regex(environmentNamePattern, 'worker_vars entries must be environment variable names')).optional(),
}).strict();

export const taskSchema = taskShape.superRefine((task, context) => {
  if (task.queue_env !== undefined && task.queue !== true) {
    context.addIssue({ code: 'custom', message: 'queue_env requires queue = true' });
  }
  if (task.queue === true && (task.background === true || queueTaskTimeoutMs(task.timeout) === null)) {
    context.addIssue({ code: 'custom', message: 'queued tasks require background != true and a positive timeout (ms, s, m, h), at most 24h' });
  }
  if (task.idle !== undefined) {
    // Refused whatever `enabled` says: a queued task ends on its own within its own finite
    // timeout and is never a `wtm start`-managed long-running process, so an idle window on one
    // is a statement about a population it does not belong to. Accepting it silently would read
    // as a promise that the queue honours it.
    if (task.queue === true) {
      context.addIssue({ code: 'custom', path: ['idle'], message: 'idle may not be combined with queue = true; a queued task already ends within its own timeout' });
    }
    if (task.idle.timeout !== undefined && idleTimeoutMs(task.idle.timeout) === null) {
      context.addIssue({ code: 'custom', path: ['idle', 'timeout'], message: 'idle timeout must be a positive duration (ms, s, m, h), at least 1s and at most 24h' });
    }
    if (task.idle.enabled === true && task.idle.timeout === undefined) {
      context.addIssue({ code: 'custom', path: ['idle', 'timeout'], message: 'idle.enabled = true requires idle.timeout' });
    }
  }
  if (task.run !== undefined && (task.main !== undefined || task.worktree !== undefined)) {
    context.addIssue({ code: 'custom', message: 'tasks may not combine run with main or worktree' });
  }

  const commands = [task.run, task.main, task.worktree].filter((command): command is string | string[] => command !== undefined);
  if (commands.some((command) => typeof command === 'string') && task.shell !== true) {
    context.addIssue({ code: 'custom', message: 'string commands require shell = true' });
  }
  if (commands.some(Array.isArray) && task.shell === true) {
    context.addIssue({ code: 'custom', message: 'argv commands may not set shell = true' });
  }
  if (task.worker_vars !== undefined) {
    // An argv element reaches wrangler as exactly one argument, whatever it contains. A shell
    // command would need each value quoted for whichever shell the host runs it through, and a
    // quoting rule that is right for one shell is an injection in another.
    if (task.shell === true) {
      context.addIssue({ code: 'custom', path: ['worker_vars'], message: 'worker_vars requires an argv command; a shell command can pass --var "NAME:$NAME" itself' });
    }
    const repeated = task.worker_vars.filter((name, index) => task.worker_vars?.indexOf(name) !== index);
    if (repeated.length > 0) {
      context.addIssue({ code: 'custom', path: ['worker_vars'], message: `worker_vars names ${repeated[0]} more than once` });
    }
  }
});

/** Field-level shape only -- see {@link taskShape}'s docstring for why. */
const portShape = z.object({
  strategy: z.enum(['stable-dynamic', 'offset', 'fixed']).optional(),
  preferred: z.number().int().min(1).max(65535).optional(),
  stride: z.number().int().positive().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /**
   * The variable this endpoint is published under. Naming it here is what turns a port into
   * something a process can read without the configuration also spelling out
   * `PORT = "{port.web}"`, which is the same fact written twice.
   */
  env: z.string().min(1).optional(),
  /**
   * Whether this endpoint is a browser origin. Origins are what a CORS allowlist is made of,
   * so an endpoint that serves something else — a database, a queue — says so and stays out.
   */
  origin: z.boolean().optional(),
}).strict();

const portSchema = portShape.superRefine((port, context) => {
  // `endpoint-plan.ts`'s `preferredPort()` only does the offset math when `preferred` is set --
  // `strategy = "offset"` with no `preferred` silently falls back to plain "any free port in
  // range" allocation, the same as no strategy at all, defeating the whole point of writing
  // `offset` down. `docs/03`'s own example always pairs the two.
  if (port.strategy === 'offset' && port.preferred === undefined) {
    context.addIssue({ code: 'custom', path: ['preferred'], message: 'strategy = "offset" requires a preferred port to offset from' });
  }
});

const corsSchema = z.object({
  /** Detection is on by default; this turns it off for a workspace that configures CORS itself. */
  enabled: z.boolean().optional(),
  /**
   * The variables the allowlist is published under. Left unset, WTM reads the variable names
   * the repository's own `.env` example files already declare.
   */
  env: z.array(z.string().min(1)).optional(),
  /** Origins to allow in addition to the ones WTM allocated for this feature. */
  origins: z.array(z.string().min(1)).optional(),
}).strict();

/**
 * A repository inside the workspace, and what only its worktrees should be told.
 *
 * A workspace holds several repositories, and most of what is worth configuring belongs to
 * one of them: the API publishes its port as `PORT`, and so does the web app — one workspace
 * `[environment]` cannot say both. Naming the repository is what lets it.
 */
/**
 * The local reverse proxy (todo item 12b). Daemon-wide: it opens one network listener for the
 * whole machine, so it is read from the global configuration the same way `[jobs]` is, not
 * per-workspace. See `docs/07`'s "Local reverse proxy" section for the hostname format and the
 * port this opts into.
 */
const proxySchema = z.object({
  /** Off by default: this opens a loopback network listener, so it is explicit opt-in. */
  enabled: z.boolean().optional(),
  /**
   * The proxy's own listening port. Left unset, the composition root that starts it picks a
   * fixed default outside `[ports].range`'s dynamic band so the two can never collide; see
   * `docs/07`'s "Local reverse proxy" section.
   */
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

/**
 * The dev overlay (todo item 46, W10-4 MVP slice): a small HTML fragment `[proxy]` injects into
 * an HTML response it proxies, showing the worktree/branch/service a running dev server belongs
 * to. Daemon-wide and off by default for the same reason `[proxy]` above is; read from the same
 * global configuration file, restart-to-apply.
 *
 * It only makes sense wherever `[proxy]` itself runs — there is nowhere else the fragment would
 * be injected from. `enabled = true` here with `[proxy]` disabled or unset is not a configuration
 * error: it is simply inert, since the proxy that would act on it never starts. See `docs/03`'s
 * "Dev overlay" section.
 */
const devOverlaySchema = z.object({
  /** Off by default, and inert unless `[proxy] enabled = true` too — see this table's own doc. */
  enabled: z.boolean().optional(),
  /**
   * Per-repository override, keyed by repository name — the same `basename(mainRoot)` convention
   * the overlay's own `repoName` already uses (`packages/daemon/src/dev-overlay.ts`). Lets one
   * noisy repository opt out of an otherwise machine-wide `enabled = true` (or opt in under an
   * otherwise-off default) without a second, per-workspace configuration surface: the overlay
   * stays a single, daemon-wide injection point (K10), this just narrows which routes it applies
   * to. A name with no entry here falls back to the table's own top-level `enabled`.
   */
  repos: z.record(z.string().min(1), z.object({
    enabled: z.boolean().optional(),
  }).strict()).optional(),
}).strict();

/**
 * General process/host-memory budgets (todo item 19). Daemon-wide, like `[jobs]` and `[proxy]`:
 * a process count and a memory floor are facts about the one machine the daemon runs on, not
 * about any single workspace, so this stays a narrow root table rather than living under a
 * `[runtime]` table WTM does not have (see `docs/07`'s "no root `runtime` table" rule).
 *
 * `max_processes` counts every process the daemon is currently managing
 * (`ManagedProcessSupervisor.list()`), host-wide. `min_available_memory_mib` is a floor on host
 * *available* memory, not a cap on WTM's own usage: WTM does not sum RSS across a process tree
 * (the heavy-job queue's own memory admission, `packages/daemon/src/job-memory.ts`, avoids that
 * for the same cost/shared-page-accuracy reasons — see `docs/07`'s "Heavy job memory admission"
 * section), so a "max_memory" usage cap would promise a measurement WTM does not take. Both
 * checks reuse that same job-memory accounting rather than adding a second one, per the todo
 * item 19/50 resource-accounting note.
 */
const budgetsSchema = z.object({
  max_processes: z.number().int().min(1).max(10_000).optional(),
  min_available_memory_mib: z.number().int().min(1).max(1_048_576).optional(),
}).strict();

const repoSchema = z.object({
  /**
   * Where the repository sits, relative to the workspace root. Left unset, the table's own
   * name is matched against the repository directory's name.
   */
  path: z.string().min(1).optional(),
  /** Variables for this repository's worktrees, layered over the workspace's own. */
  environment: z.record(z.string(), z.string()).optional(),
}).strict();

const resourceSchema = z.object({
  path: z.string().min(1),
  policy: z.enum(['shared', 'native-cache', 'clone', 'isolated', 'symlink', 'copy', 'ephemeral', 'external', 'ignore']),
  source: z.string().min(1).optional(),
  optional: z.boolean().optional(),
  retention: z.enum(['ephemeral', 'persistent']).optional(),
}).strict();

const portsShape = z.object({
  strategy: z.enum(['stable-dynamic']).optional(),
  range: z.string().min(1).optional(),
}).passthrough();

const portsSchema = portsShape.superRefine((ports, context) => {
  // A fixed port is never leased (see `endpoint-plan.ts`'s `fixedPort`, deliberately: leasing it
  // would let the allocator move it the moment something else holds it), so it never reaches the
  // one place collisions are otherwise caught -- `endpoint_leases`'s active-port uniqueness. Two
  // `[ports.<name>]` entries naming the same literal port would resolve silently to the same
  // number, with nothing failing until whichever process binds second gets a bare OS
  // `EADDRINUSE`. Caught here instead, at config load, the same way every other cross-field
  // `[ports]` rule is.
  const fixedPortNames = new Map<number, string[]>();
  for (const [name, value] of Object.entries(ports)) {
    if (name === 'strategy' || name === 'range') continue;
    const parsed = portSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          ...issue,
          path: [name, ...issue.path],
        });
      }
      continue;
    }
    if (parsed.data.strategy === 'fixed' && parsed.data.port !== undefined) {
      const names = fixedPortNames.get(parsed.data.port) ?? [];
      names.push(name);
      fixedPortNames.set(parsed.data.port, names);
    }
  }
  for (const [port, names] of fixedPortNames) {
    if (names.length < 2) continue;
    for (const name of names) {
      context.addIssue({
        code: 'custom',
        path: [name, 'port'],
        message: `Port ${port} is used by more than one fixed [ports] entry (${names.join(', ')}). Each fixed port must be unique.`,
      });
    }
  }
});

/**
 * Field-level shape only -- see {@link taskShape}'s docstring for why. `[ports.<name>]` entries
 * still get their own per-field validation (a `preferred` that isn't a number is still wrong on
 * its own, in one file), but the fixed-port-collision and offset-requires-preferred rules can
 * span layers (two files each naming one fixed port, or `strategy` and `preferred` landing in
 * different files) exactly the way {@link taskShape}'s cross-field rules can, so those are left
 * for the merged result.
 */
const portsShapeOnly = portsShape.superRefine((ports, context) => {
  for (const [name, value] of Object.entries(ports)) {
    if (name === 'strategy' || name === 'range') continue;
    const parsed = portShape.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ ...issue, path: [name, ...issue.path] });
      }
    }
  }
});

/**
 * Which remote-tracking refs count as "this branch is safely persisted elsewhere" for `wtm
 * remove` and `wtm analyze`. Validated with the exact rule {@link normalizeAllowedRemoteRefs}
 * enforces at analysis time, so a pattern that would later throw a bare `TypeError` deep inside
 * `analyzeRemotePersistence` is instead reported here, at config load, as a coded
 * `WTM_CONFIG_INVALID` naming the offending pattern.
 */
/** Field-level shape only -- see {@link taskShape}'s docstring for why. */
const gitShape = z.object({
  allowed_remote_refs: z.array(z.string().min(1)).min(1).optional(),
}).strict();

const gitSchema = gitShape.superRefine((git, context) => {
  if (git.allowed_remote_refs === undefined) return;
  try {
    normalizeAllowedRemoteRefs(git.allowed_remote_refs);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      path: ['allowed_remote_refs'],
      message: error instanceof Error ? error.message : 'Invalid allowed remote-tracking ref pattern.',
    });
  }
});

/**
 * Built twice: once with the full task/ports/git schemas (their `superRefine` cross-field rules
 * included) for {@link wtmConfigSchema}, and once with the field-shape-only variants for
 * {@link parseWtmConfigLayer}'s per-layer validation. Kept as one factory rather than two literal
 * copies so a field added here can never drift out of sync between the two -- see
 * {@link taskShape}'s docstring for why the split exists at all.
 */
function buildWtmConfigSchema<Task extends z.ZodTypeAny, Ports extends z.ZodTypeAny, Git extends z.ZodTypeAny>(
  task: Task,
  ports: Ports,
  git: Git,
) {
  return z.object({
    jobs: z.object({
      max_concurrent_heavy: z.number().int().min(1).max(64).optional(),
      memory: z.object({
        budget_mib: z.number().int().min(1).max(1_048_576),
        reserve_mib: z.number().int().min(0).max(1_048_576).optional(),
      }).strict().optional(),
    }).strict().optional(),
    git: git.optional(),
    safety: z.object({ untracked_symlinks: z.enum(['ignore', 'review', 'block']).optional() }).strict().optional(),
    version: z.literal(1).optional(),
    workspace: z.object({ name: z.string().min(1).optional() }).strict().optional(),
    discovery: z.object({
      repos: z.boolean().optional(),
      worktrees: z.boolean().optional(),
      max_depth: z.number().int().nonnegative().optional(),
    }).strict().optional(),
    prepare: z.object({ mode: z.enum(['lazy', 'eager']).optional() }).strict().optional(),
    ports: ports.optional(),
    cors: corsSchema.optional(),
    proxy: proxySchema.optional(),
    'dev-overlay': devOverlaySchema.optional(),
    budgets: budgetsSchema.optional(),
    repos: z.record(z.string(), repoSchema).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    tasks: z.record(z.string(), task).optional(),
    events: z.record(z.string(), z.object({ tasks: z.array(z.string().min(1)) }).strict()).optional(),
    resources: z.record(z.string(), resourceSchema).optional(),
    identity: z.object({
      strategy: z.enum(['persistent']).optional(),
      reuse_ids: z.boolean().optional(),
    }).strict().optional(),
    capabilities: z.record(z.string(), z.string().min(1)).optional(),
  }).strict();
}

export const wtmConfigSchema = buildWtmConfigSchema(taskSchema, portsSchema, gitSchema);

/** Per-layer counterpart of {@link wtmConfigSchema} -- see {@link buildWtmConfigSchema}. */
const wtmConfigShapeSchema = buildWtmConfigSchema(taskShape, portsShapeOnly, gitShape);

export type TaskConfig = z.infer<typeof taskSchema>;
export type PortConfig = z.infer<typeof portSchema>;
export type GitConfig = z.infer<typeof gitSchema>;
export type CorsConfig = z.infer<typeof corsSchema>;
export type ProxyConfig = z.infer<typeof proxySchema>;
export type DevOverlayConfig = z.infer<typeof devOverlaySchema>;
export type BudgetsConfig = z.infer<typeof budgetsSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;
export type ResourceConfig = z.infer<typeof resourceSchema>;
export type PortsConfig = {
  strategy?: 'stable-dynamic';
  range?: string;
  web?: PortConfig;
  api?: PortConfig;
  [name: string]: unknown;
};
type WtmConfigSchemaOutput = z.infer<typeof wtmConfigSchema>;
export type WtmConfig = Omit<WtmConfigSchemaOutput, 'ports'> & { ports?: PortsConfig };

export interface ConfigErrorShape {
  code: 'WTM_CONFIG_INVALID';
  severity: 'error';
  context: Record<string, unknown>;
}

export class WtmConfigError extends Error implements ConfigErrorShape {
  readonly code = 'WTM_CONFIG_INVALID' as const;
  readonly severity = 'error' as const;

  constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WtmConfigError';
  }
}

export function parseWtmConfig(value: unknown, source?: string): WtmConfig {
  const parsed = wtmConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data as WtmConfig;

  throw new WtmConfigError('WTM configuration is invalid.', {
    ...(source === undefined ? {} : { source }),
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

/**
 * Validates one config file's own content before it is merged with the workspace's other layers
 * -- global, workspace, nested-directory, per-repository. Enforces every field's own shape (a
 * `preferred` port that isn't a number is wrong regardless of what any other layer says) but
 * skips the cross-field rules `parseWtmConfig`'s full schema also carries (`queue_env` needs
 * `queue = true`, `idle.enabled` needs `idle.timeout`, a fixed `[ports]` entry must not collide
 * with another): those fields can legitimately be set in different layers and only make sense
 * read together, so checking them against one file in isolation rejected configurations that
 * were valid once merged. `resolveWorkspaceConfig` still runs the full `parseWtmConfig` on the
 * merged result, which is where those rules are actually enforced.
 */
export function parseWtmConfigLayer(value: unknown, source?: string): WtmConfig {
  const parsed = wtmConfigShapeSchema.safeParse(value);
  if (parsed.success) return parsed.data as WtmConfig;

  throw new WtmConfigError('WTM configuration is invalid.', {
    ...(source === undefined ? {} : { source }),
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}
