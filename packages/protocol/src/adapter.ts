import { z } from 'zod';
import { wtmErrorSchema } from './errors';

export const protocolVersionSchema = z.object({
  major: z.literal(1),
  minor: z.number().int().nonnegative(),
}).strict();

export const protocolVersion = { major: 1, minor: 0 } as const;

/** V1.0 has no forward-compatible fields; future minors must opt in explicitly. */
export function isProtocolVersionCompatible(version: ProtocolVersion): boolean {
  return version.major === protocolVersion.major && version.minor === protocolVersion.minor;
}

const adapterOperationSchema = z.enum(['metadata', 'detect', 'plan', 'doctor', 'cleanup-plan']);
const adapterContextShape = {
  workspace: z.object({ root: z.string().min(1) }).strict(),
  repository: z.object({ root: z.string().min(1), mainRoot: z.string().min(1) }).strict(),
  worktree: z.object({
    root: z.string().min(1), id: z.number().int().nonnegative(), branch: z.string().min(1).nullable(),
  }).strict(),
};

export const adapterContextSchema = z.object(adapterContextShape).strict();

export const adapterRequestSchema = z.discriminatedUnion('operation', [
  z.object({ protocol: protocolVersionSchema, operation: z.literal('metadata') }).strict(),
  z.object({ protocol: protocolVersionSchema, operation: z.literal('detect'), ...adapterContextShape }).strict(),
  z.object({ protocol: protocolVersionSchema, operation: z.literal('plan'), ...adapterContextShape }).strict(),
  z.object({ protocol: protocolVersionSchema, operation: z.literal('doctor'), ...adapterContextShape }).strict(),
  z.object({ protocol: protocolVersionSchema, operation: z.literal('cleanup-plan'), ...adapterContextShape }).strict(),
]);

export const adapterMetadataSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), version: z.string().min(1),
  kind: z.string().min(1), provides: z.array(z.string().min(1)),
  requires: z.array(z.string().min(1)).optional(),
}).strict();

export const adapterMetadataResponseSchema = z.object({
  protocol: protocolVersionSchema,
  adapter: adapterMetadataSchema,
}).strict();

export const detectionResultSchema = z.object({
  detected: z.boolean(), confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({ kind: z.string().min(1), value: z.string().min(1) }).strict()),
}).strict();

export const adapterDetectionResponseSchema = detectionResultSchema;

export const adapterResourcePolicySchema = z.enum([
  'shared', 'native-cache', 'clone', 'isolated', 'symlink', 'copy', 'ephemeral', 'external', 'ignore',
]);

export const adapterResourceSchema = z.object({
  name: z.string().min(1), type: z.string().min(1), path: z.string().min(1),
  policy: adapterResourcePolicySchema, retention: z.enum(['ephemeral', 'persistent']),
}).strict();

export const adapterActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ensure-directory'), resource: z.string().min(1), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal('symlink'), resource: z.string().min(1), source: z.string().min(1), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('copy'), resource: z.string().min(1), source: z.string().min(1), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('clone'), resource: z.string().min(1), source: z.string().min(1), target: z.string().min(1) }).strict(),
  z.object({ type: z.literal('write-generated-file'), resource: z.string().min(1), path: z.string().min(1), contents: z.string() }).strict(),
  z.object({ type: z.literal('reserve-endpoint'), name: z.string().min(1) }).strict(),
  z.object({
    type: z.literal('exec'), argv: z.array(z.string()).min(1), cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  z.object({ type: z.literal('register-runtime-namespace'), namespace: z.string().min(1) }).strict(),
]);

const adapterTaskCommandSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

export const adapterTaskSchema = z.object({
  description: z.string().min(1).optional(),
  run: adapterTaskCommandSchema,
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  background: z.boolean().optional(),
  singleton: z.boolean().optional(),
  requires: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict().superRefine((task, context) => {
  if (typeof task.run === 'string' && task.shell !== true) {
    context.addIssue({ code: 'custom', message: 'string task commands require shell = true' });
  }
  if (Array.isArray(task.run) && task.shell === true) {
    context.addIssue({ code: 'custom', message: 'argv task commands may not set shell = true' });
  }
});

export const adapterPlanSchema = z.object({
  resources: z.array(adapterResourceSchema),
  actions: z.array(adapterActionSchema),
  capabilities: z.record(z.string().min(1), z.object({ action: z.string().min(1) }).strict()),
  tasks: z.record(z.string().min(1), adapterTaskSchema).default({}),
}).strict().superRefine((plan, context) => {
  const seen = new Set<string>();
  plan.resources.forEach((resource, index) => {
    if (seen.has(resource.name)) {
      context.addIssue({
        code: 'custom', path: ['resources', index, 'name'],
        message: 'declared resource names must be unique',
      });
    }
    seen.add(resource.name);
  });
  const declared = new Set(plan.resources.map((resource) => resource.name));
  plan.actions.forEach((action, index) => {
    if (!('resource' in action) || declared.has(action.resource)) return;
    context.addIssue({
      code: 'custom',
      path: ['actions', index, 'resource'],
      message: 'filesystem mutation resource must identify one declared resource',
    });
  });
});

export const adapterPlanResponseSchema = adapterPlanSchema;

/** The smallest structured doctor result: deterministic adapter findings. */
export const doctorCheckSchema = wtmErrorSchema;
export const adapterDoctorResponseSchema = z.object({ findings: z.array(doctorCheckSchema) }).strict();

/** Cleanup can delete only a WTM-owned resource identified by name. */
export const adapterCleanupPlanResponseSchema = z.object({
  actions: z.array(z.object({ type: z.literal('delete-owned-resource'), resource: z.string().min(1) }).strict()),
}).strict();

/** Adapter stdout is an operation payload; the request associates its operation. */
export const adapterResponseSchema = z.union([
  adapterMetadataResponseSchema,
  adapterDetectionResponseSchema,
  adapterPlanResponseSchema,
  adapterDoctorResponseSchema,
  adapterCleanupPlanResponseSchema,
]);

export function parseAdapterResponse(operation: AdapterOperation, payload: unknown): AdapterResponse {
  switch (operation) {
    case 'metadata': return adapterMetadataResponseSchema.parse(payload);
    case 'detect': return adapterDetectionResponseSchema.parse(payload);
    case 'plan': return adapterPlanResponseSchema.parse(payload);
    case 'doctor': return adapterDoctorResponseSchema.parse(payload);
    case 'cleanup-plan': return adapterCleanupPlanResponseSchema.parse(payload);
  }
}

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
export type AdapterMetadata = z.infer<typeof adapterMetadataSchema>;
export type AdapterContext = z.infer<typeof adapterContextSchema>;
export type DetectionResult = z.infer<typeof detectionResultSchema>;
export type AdapterPlan = z.infer<typeof adapterPlanSchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;
export interface BuiltInAdapter {
  metadata(): AdapterMetadata;
  detect(ctx: AdapterContext): Promise<DetectionResult>;
  plan(ctx: AdapterContext): Promise<AdapterPlan>;
  doctor(ctx: AdapterContext): Promise<DoctorCheck[]>;
}
export type AdapterRequest = z.infer<typeof adapterRequestSchema>;
export type AdapterMetadataResponse = z.infer<typeof adapterMetadataResponseSchema>;
export type AdapterDetectionResponse = z.infer<typeof adapterDetectionResponseSchema>;
export type AdapterPlanResponse = z.infer<typeof adapterPlanResponseSchema>;
export type AdapterDoctorResponse = z.infer<typeof adapterDoctorResponseSchema>;
export type AdapterCleanupPlanResponse = z.infer<typeof adapterCleanupPlanResponseSchema>;
export type AdapterResponse = z.infer<typeof adapterResponseSchema>;
export type AdapterOperation = z.infer<typeof adapterOperationSchema>;
