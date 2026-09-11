import { z } from 'zod';
import { defaultReadinessTimeoutMs, maxReadinessTimeoutMs, readinessDurationMs } from '@wtm/protocol';

export const healthcheckSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1).max(8192),
  timeout: z.string().refine((value) => readinessDurationMs(value) !== null, 'Healthcheck timeout must be 1ms to 5m.').optional(),
  interval: z.string().refine((value) => {
    const duration = readinessDurationMs(value);
    return duration !== null && duration >= 100 && duration <= 30_000;
  }, 'Healthcheck interval must be 100ms to 30s.').optional(),
}).strict();

export interface ResolvedHealthcheck {
  type: 'http';
  url: string;
  timeoutMs: number;
  intervalMs: number;
}

export const resolvedHealthcheckSchema = z.object({
  type: z.literal('http'),
  url: z.string().max(8192).refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' && url.hash === '';
    } catch { return false; }
  }, 'Healthcheck requires an HTTP(S) URL without credentials or a fragment.'),
  timeoutMs: z.number().int().min(1).max(maxReadinessTimeoutMs),
  intervalMs: z.number().int().min(100).max(30_000),
}).strict();

/** Validate after templates resolve, before start/restart can change a running service. */
export function resolveHealthcheck(
  config: z.infer<typeof healthcheckSchema>,
  resolve: (value: string) => string,
): ResolvedHealthcheck {
  const url = new URL(resolve(config.url));
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('Healthcheck requires an HTTP(S) URL without credentials or a fragment.');
  }
  return resolvedHealthcheckSchema.parse({
    type: 'http', url: url.href,
    timeoutMs: config.timeout === undefined ? defaultReadinessTimeoutMs : readinessDurationMs(config.timeout)!,
    intervalMs: config.interval === undefined ? 500 : readinessDurationMs(config.interval)!,
  });
}
