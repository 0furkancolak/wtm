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
