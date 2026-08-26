import { z } from 'zod';
import { wtmErrorSchema, type WtmError } from './errors';
import { schemaVersionSchema, type SchemaVersion } from './schema-version';

export const scopeSchema = z.object({
  mode: z.enum(['local', 'global']),
  workspaceId: z.string().min(1).optional(),
}).strict();

const envelopeBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  command: z.string().min(1),
  scope: scopeSchema.optional(),
  data: z.unknown(),
  warnings: z.array(wtmErrorSchema),
  errors: z.array(wtmErrorSchema),
}).strict();

export const jsonEnvelopeSchema = z.union([
  envelopeBaseSchema.extend({ ok: z.literal(true), errors: z.array(wtmErrorSchema) }),
  envelopeBaseSchema.extend({ ok: z.literal(false), errors: z.array(wtmErrorSchema).min(1) }),
]);

interface JsonEnvelopeBase<T> {
  schemaVersion: SchemaVersion;
  command: string;
  scope?: z.infer<typeof scopeSchema>;
  data: T;
  warnings: WtmError[];
}

export interface JsonSuccessEnvelope<T> extends JsonEnvelopeBase<T> {
  ok: true;
  errors: WtmError[];
}

export interface JsonFailureEnvelope<T> extends JsonEnvelopeBase<T> {
  ok: false;
  errors: [WtmError, ...WtmError[]];
}

export type JsonEnvelope<T> = JsonSuccessEnvelope<T> | JsonFailureEnvelope<T>;
