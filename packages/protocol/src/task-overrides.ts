import { z } from 'zod';
import { readinessDurationMs } from './runtime';

const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** Same bounds as `packages/core/src/config/healthcheck.ts`'s `healthcheckSchema`. */
const taskHealthcheckSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1).max(8192),
  timeout: z.string().refine((value) => readinessDurationMs(value) !== null, 'Healthcheck timeout must be 1ms to 5m.').optional(),
  interval: z.string().refine((value) => {
    const duration = readinessDurationMs(value);
    return duration !== null && duration >= 100 && duration <= 30_000;
  }, 'Healthcheck interval must be 100ms to 30s.').optional(),
}).strict();

/** Same bounds as `packages/core/src/config/idle.ts`'s `idleSchema`. */
const taskIdleSchema = z.object({
  enabled: z.boolean().optional(),
  timeout: z.string().min(1).optional(),
}).strict();

/**
 * The wire shape of a task, mirroring `packages/core/src/config/schema.ts`'s `taskSchema` (a
 * `[tasks.<name>]` block). Kept as its own schema, not an import from `@wtm/core`, because
 * `protocol` has no dependency on `core` — the layering is `protocol ← platform ← core`.
 *
 * This validates shape only; the cross-field rules `taskSchema`'s `superRefine` enforces (queue
 * requires a timeout, a string command requires `shell`, idle is refused alongside queue, and so
 * on) are core's business rules, not wire format, so they are re-checked authoritatively where
 * the daemon writes the override (`packages/daemon/src/task-overrides-handler.ts`), the same way
 * any other WTM_CONFIG_INVALID is raised.
 */
export const taskOverrideValueSchema = z.object({
  description: z.string().min(1).optional(),
  expose: z.boolean().optional(),
  run: commandSchema.optional(),
  main: commandSchema.optional(),
  worktree: commandSchema.optional(),
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  background: z.boolean().optional(),
  healthcheck: taskHealthcheckSchema.optional(),
  idle: taskIdleSchema.optional(),
  queue: z.boolean().optional(),
  memory_estimate_mib: z.number().int().min(1).max(1_048_576).optional(),
  queue_env: z.record(z.string().min(1), z.string()).optional(),
  singleton: z.boolean().optional(),
  grace_period: z.string().min(1).optional(),
  timeout: z.string().min(1).optional(),
  on_failure: z.enum(['fail', 'warn', 'continue']).optional(),
  requires: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Same pattern as `packages/core/src/config/schema.ts`'s `environmentNamePattern`. */
  worker_vars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
}).strict();
export type TaskOverrideValue = z.infer<typeof taskOverrideValueSchema>;

const taskNameSchema = z.string().min(1).max(256);

export const taskOverrideRecordSchema = z.object({
  taskName: taskNameSchema,
  task: taskOverrideValueSchema,
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
}).strict();
export type TaskOverrideRecordWire = z.infer<typeof taskOverrideRecordSchema>;

export const taskOverrideArgumentSchemas = {
  'task.list': z.object({ cwd: z.string().min(1).max(4096) }).strict(),
  'task.show': z.object({ cwd: z.string().min(1).max(4096), taskName: taskNameSchema }).strict(),
  'task.set': z.object({ cwd: z.string().min(1).max(4096), taskName: taskNameSchema, task: taskOverrideValueSchema }).strict(),
  'task.unset': z.object({ cwd: z.string().min(1).max(4096), taskName: taskNameSchema }).strict(),
} as const;
export const taskOverrideCommandNames: ReadonlySet<string> = new Set(Object.keys(taskOverrideArgumentSchemas));
export type TaskOverrideCommand = keyof typeof taskOverrideArgumentSchemas;

export const taskOverrideListResultSchema = z.object({ tasks: z.array(taskOverrideRecordSchema) }).strict();
export const taskOverrideShowResultSchema = z.object({ task: taskOverrideRecordSchema.nullable() }).strict();
export const taskOverrideSetResultSchema = z.object({ task: taskOverrideRecordSchema }).strict();
export const taskOverrideUnsetResultSchema = z.object({ removed: z.boolean() }).strict();
