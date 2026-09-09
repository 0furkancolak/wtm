import { z } from 'zod';

export const jobStateSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED']);
export type JobState = z.infer<typeof jobStateSchema>;
export const sourceValiditySchema = z.enum(['UNCHANGED', 'CHANGED', 'UNKNOWN']);
export type SourceValidity = z.infer<typeof sourceValiditySchema>;
export const jobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const idempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const jobSelectorSchema = z.object({ jobId: jobIdSchema }).strict();

export const jobArgumentSchemas = {
  'jobs.enqueue': z.object({
    cwd: z.string().min(1).max(4096),
    taskName: z.string().min(1).max(256),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  'jobs.list': z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'jobs.status': jobSelectorSchema,
  'jobs.result': jobSelectorSchema,
  'jobs.cancel': jobSelectorSchema,
  'jobs.logs': z.object({ jobId: jobIdSchema, tail: z.number().int().min(1).max(1000).default(100) }).strict(),
} as const;
export const jobCommandNames: ReadonlySet<string> = new Set(Object.keys(jobArgumentSchemas));
export type JobCommand = keyof typeof jobArgumentSchemas;

/** Acceptance proves durable admission, including a retry of an already completed job. */
export const enqueueAcceptanceSchema = z.object({
  accepted: z.literal(true),
  jobId: jobIdSchema,
  state: jobStateSchema,
  idempotencyKey: idempotencyKeySchema,
  reused: z.boolean(),
}).strict();
export type EnqueueAcceptance = z.infer<typeof enqueueAcceptanceSchema>;
