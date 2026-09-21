import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { parseWtmConfig, type WtmConfig } from '@wtm/core';

/**
 * The global configuration file, parsed leniently: a missing file (never initialized, or a test
 * that never wrote one) reads as an empty configuration rather than an error, the same tolerance
 * `globalProxyPolicy`/`globalDevOverlayPolicy` below and `runtime-factory.ts`'s `globalJobPolicy`
 * each need for their own table. A malformed file still throws `WtmConfigError`, exactly as
 * `parseWtmConfig` always does.
 */
async function readGlobalWtmConfig(path: string): Promise<WtmConfig> {
  let value: string;
  try { value = await readFile(path, 'utf8'); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseWtmConfig(parse(value), path);
}

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
  return (await readGlobalWtmConfig(path)).proxy ?? {};
}

/**
 * The dev overlay's policy (todo item 46, W10-4 MVP slice): whether the proxy should inject its
 * small identity/sibling-endpoints fragment into the HTML responses it proxies. Read from the
 * same global configuration file `[proxy]` is, for the same reason: an overlay only makes sense
 * wherever the proxy that would inject it actually runs. When `[proxy]` is disabled or unset,
 * this policy being `enabled = true` is simply inert rather than an error — see `docs/03`'s
 * "Dev overlay" section.
 */
export async function globalDevOverlayPolicy(path: string): Promise<NonNullable<WtmConfig['dev-overlay']>> {
  return (await readGlobalWtmConfig(path))['dev-overlay'] ?? {};
}
