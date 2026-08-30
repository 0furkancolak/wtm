import { z } from 'zod';

const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const taskSchema = z.object({
  description: z.string().min(1).optional(),
  expose: z.boolean().optional(),
  run: commandSchema.optional(),
  main: commandSchema.optional(),
  worktree: commandSchema.optional(),
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  background: z.boolean().optional(),
  singleton: z.boolean().optional(),
  grace_period: z.string().min(1).optional(),
  timeout: z.string().min(1).optional(),
  on_failure: z.enum(['fail', 'warn', 'continue']).optional(),
  requires: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict().superRefine((task, context) => {
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
});

const portSchema = z.object({
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

const portsSchema = z.object({
  strategy: z.enum(['stable-dynamic']).optional(),
  range: z.string().min(1).optional(),
}).passthrough().superRefine((ports, context) => {
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
    }
  }
});

export const wtmConfigSchema = z.object({
  version: z.literal(1).optional(),
  workspace: z.object({ name: z.string().min(1).optional() }).strict().optional(),
  discovery: z.object({
    repos: z.boolean().optional(),
    worktrees: z.boolean().optional(),
    max_depth: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  prepare: z.object({ mode: z.enum(['lazy', 'eager']).optional() }).strict().optional(),
  ports: portsSchema.optional(),
  cors: corsSchema.optional(),
  repos: z.record(z.string(), repoSchema).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  tasks: z.record(z.string(), taskSchema).optional(),
  events: z.record(z.string(), z.object({ tasks: z.array(z.string().min(1)) }).strict()).optional(),
  resources: z.record(z.string(), resourceSchema).optional(),
  identity: z.object({
    strategy: z.enum(['persistent']).optional(),
    reuse_ids: z.boolean().optional(),
  }).strict().optional(),
  capabilities: z.record(z.string(), z.string().min(1)).optional(),
}).strict();

export type PortConfig = z.infer<typeof portSchema>;
export type CorsConfig = z.infer<typeof corsSchema>;
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
