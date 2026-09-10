import { z } from 'zod';

export const defaultReadinessTimeoutMs = 30_000;
export const maxReadinessTimeoutMs = 300_000;
export const readinessLaunchAllowanceMs = 30_000;

/** One bounded duration grammar for config, CLI and IPC observation deadlines. */
export function readinessDurationMs(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  if (match === null) return null;
  const factor = { ms: 1, s: 1000, m: 60_000 }[match[2] as 'ms' | 's' | 'm'];
  const result = Number(match[1]) * factor;
  return Number.isSafeInteger(result) && result >= 1 && result <= maxReadinessTimeoutMs ? result : null;
}

export const runtimeStartArgumentsSchema = z.object({
  cwd: z.string().min(1).max(4096),
  taskName: z.string().min(1).max(256),
  wait: z.boolean().optional(),
  waitTimeoutMs: z.number().int().min(1).max(maxReadinessTimeoutMs).optional(),
}).strict().refine((args) => args.waitTimeoutMs === undefined || args.wait === true, {
  message: 'A readiness timeout requires wait = true.',
});

export const readinessObservationSchema = z.object({
  state: z.enum(['NOT_CHECKED', 'READY', 'TIMED_OUT', 'PROCESS_EXITED', 'PROCESS_CHANGED', 'IDENTITY_UNCERTAIN', 'EVIDENCE_UNAVAILABLE', 'ABORTED']),
  probe: z.literal('http').nullable(),
  attempts: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  observedAt: z.string().datetime().nullable(),
}).strict();

export type RuntimeStartArguments = z.infer<typeof runtimeStartArgumentsSchema>;
export type ReadinessObservation = z.infer<typeof readinessObservationSchema>;
