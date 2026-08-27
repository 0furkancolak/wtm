import { z } from 'zod';
import { protocolVersionSchema } from './adapter';
import { jsonEnvelopeSchema } from './json-envelope';

export const ipcRequestSchema = z.object({
  protocol: protocolVersionSchema,
  id: z.string().min(1).max(128),
  command: z.string().min(1).max(128),
  arguments: z.unknown().optional(),
}).strict();

export const ipcResponseSchema = z.object({
  protocol: protocolVersionSchema,
  id: z.string().min(1).max(128),
  envelope: jsonEnvelopeSchema,
}).strict();

export type IpcRequest = z.infer<typeof ipcRequestSchema>;
export type IpcResponse = z.infer<typeof ipcResponseSchema>;
