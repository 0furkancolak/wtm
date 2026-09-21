import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { parseWtmConfig, type WtmConfig } from '@wtm/core';

/**
 * The local reverse proxy's policy, read from the same global configuration file `[jobs]` is —
 * it opens one machine-wide loopback listener, which is a daemon setting rather than a
 * per-workspace one (decision 6 in the W9-4 plan; `docs/03`'s "Local reverse proxy" section).
 *
 * Shared by `runtime-factory.ts` (which starts the proxy itself) and `task-resolution.ts` (which
 * reads this same policy to decide whether a worktree's CORS allowlist should carry the proxy
 * hostname alongside the dynamic-port origin, W10-1), so the parse-and-catch-ENOENT here has one
 * copy instead of two that could drift apart.
 */
export async function globalProxyPolicy(path: string): Promise<NonNullable<WtmConfig['proxy']>> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseWtmConfig(parse(value), path).proxy ?? {};
}
