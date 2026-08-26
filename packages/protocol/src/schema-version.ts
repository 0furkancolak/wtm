import { z } from 'zod';

export const schemaVersionSchema = z.literal(1);

export type SchemaVersion = z.infer<typeof schemaVersionSchema>;
