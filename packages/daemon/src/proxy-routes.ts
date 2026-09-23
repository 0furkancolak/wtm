import {
  assignProxySlugs,
  proxyHostname,
  type EndpointLease,
  type WorktreeRecord,
} from '@wtm/core';
import { deadWorktreeStates } from './task-resolution';

/** One resolved route: where the proxy connects to serve a canonical hostname. */
export interface ProxyRoute {
  hostname: string;
  /** Always loopback — see `buildProxyRoutes`'s filter below. */
  host: string;
  port: number;
  worktreeId: string;
  service: string;
}

/**
 * What `buildProxyRoutes` needs from the state store: the same shape `resolveWorktreeRuntime`
 * and friends already read, which is what confirms decision 5 (no new persisted routing table)
 * is actually sufficient — active leases and worktree records are already queried this way
 * elsewhere in the daemon.
 */
export interface ProxyRouteSource {
  listWorktrees(): WorktreeRecord[];
  listEndpointLeases(query?: { states?: readonly ('ACTIVE' | 'RELEASED')[] }): EndpointLease[];
}

const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Builds the whole hostname -> backend map from the daemon's existing state, fresh on every
 * call. There is no cache to invalidate: a lease that moved, or a worktree that was removed
 * between two requests, is simply absent (or different) the next time this runs. The store's
 * queries are synchronous, in-process SQLite reads over a handful of rows per workspace, so
 * recomputing per proxied request costs nothing a developer would notice — and it is what keeps
 * decision 5's "daemon memory, not a new table" honest: this reads the *existing* endpoint-lease
 * and worktree tables directly, rather than mirroring them into a second structure that could
 * drift from what actually holds a port.
 */
export function buildProxyRoutes(store: ProxyRouteSource): ReadonlyMap<string, ProxyRoute> {
  const leases = store.listEndpointLeases({ states: ['ACTIVE'] })
    .filter((lease) => lease.protocol === 'tcp' && loopbackHosts.has(lease.host));
  const routes = new Map<string, ProxyRoute>();
  if (leases.length === 0) return routes;

  // `assignProxySlugs` promises the worktree WTM has held longest keeps the plain slug, so a
  // bookmarked hostname never moves underneath it -- that promise only holds if every worktree
  // that could still claim a slug is in the group it disambiguates over, not only the ones with
  // an active lease right now. Scoping to active leases let a younger, currently-leased worktree
  // take the plain slug while an older, currently-idle sibling was absent from the comparison,
  // and reassigned the plain slug (and the hostname a browser tab is already pointed at) out from
  // under it the moment that older worktree started a task too. Worktrees that are gone or being
  // torn down are still excluded, so a removed worktree does not squat its slug forever.
  const worktrees = store.listWorktrees().filter((worktree) => !deadWorktreeStates.has(worktree.state));
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree] as const));
  const slugs = assignProxySlugs(worktrees);

  for (const lease of leases) {
    const worktree = worktreesById.get(lease.worktreeId);
    const slug = worktree === undefined ? undefined : slugs.get(worktree.id);
    if (worktree === undefined || slug === undefined) continue;
    const hostname = proxyHostname(lease.name, slug);
    routes.set(hostname, {
      hostname,
      host: lease.host,
      port: lease.port,
      worktreeId: worktree.id,
      service: lease.name,
    });
  }
  return routes;
}

/** Looks a hostname up against a freshly-built routing table. */
export function resolveProxyRoute(store: ProxyRouteSource, hostname: string): ProxyRoute | null {
  return buildProxyRoutes(store).get(hostname) ?? null;
}
