import { z } from 'zod';

/** A commit is watched, not a branch: the key is the full object name (SHA-1 or SHA-256). */
const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const ciWatchStateSchema = z.enum([
  'pending', 'success', 'failure', 'cancelled', 'timed_out', 'no_runs', 'superseded', 'unavailable',
]);
export type CiWatchState = z.infer<typeof ciWatchStateSchema>;

export const ciJobSchema = z.object({
  jobId: z.number().int().nonnegative(),
  name: z.string().max(512),
  status: z.string().max(64),
  conclusion: z.string().max(64).nullable(),
  url: z.string().max(2048),
  logSummary: z.string().max(8192).optional(),
}).strict();
export type CiJob = z.infer<typeof ciJobSchema>;

export const ciRunSchema = z.object({
  runId: z.number().int().nonnegative(),
  workflow: z.string().max(512),
  event: z.string().max(128),
  status: z.string().max(64),
  conclusion: z.string().max(64).nullable(),
  url: z.string().max(2048),
  jobs: z.array(ciJobSchema).max(256),
}).strict();
export type CiRun = z.infer<typeof ciRunSchema>;

export const ciWatchSchema = z.object({
  watchId: z.string().min(1).max(128),
  repo: z.string().min(1).max(512),
  branch: z.string().max(1024).nullable(),
  headSha: commitSchema,
  pr: z.number().int().positive().optional(),
  state: ciWatchStateSchema,
  startedAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  finishedAt: z.string().min(1).max(64).optional(),
  runs: z.array(ciRunSchema).max(64),
  detail: z.string().max(512).optional(),
}).strict();
export type CiWatch = z.infer<typeof ciWatchSchema>;

export const ciArgumentSchemas = {
  'ci.watch': z.object({
    cwd: z.string().min(1).max(4096),
    branch: z.string().max(1024).nullable(),
    headSha: commitSchema,
    pr: z.number().int().positive().optional(),
  }).strict(),
  'ci.unwatch': z.object({ cwd: z.string().min(1).max(4096) }).strict(),
} as const;
export const ciCommandNames: ReadonlySet<string> = new Set(Object.keys(ciArgumentSchemas));
export type CiCommand = keyof typeof ciArgumentSchemas;

export const ciWatchAcceptanceSchema = z.object({ watch: ciWatchSchema, reused: z.boolean() }).strict();
export const ciUnwatchResultSchema = z.object({ stopped: z.boolean(), watch: ciWatchSchema.nullable() }).strict();
