import { describe, expect, it } from 'bun:test';
import type { EndpointLease, WorktreeRecord } from '@wtm/core';
import { buildProxyRoutes, resolveProxyRoute, type ProxyRouteSource } from '../proxy-routes';

function worktree(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'worktree-1',
    repositoryId: 'repo-1',
    numericId: 1,
    path: '/repo/worktrees/auth',
    branch: 'feature/auth',
    headOid: 'deadbeef',
    isMain: false,
    isLocked: false,
    state: 'RUNNING',
    createdAt: '2026-09-21T09:00:00.000Z',
    lastSeenAt: '2026-09-21T09:00:00.000Z',
    lastRuntimeAt: null,
    ...overrides,
  };
}

function lease(overrides: Partial<EndpointLease> = {}): EndpointLease {
  return {
    id: 'lease-1',
    worktreeId: 'worktree-1',
    name: 'web',
    protocol: 'tcp',
    host: '127.0.0.1',
    port: 23_671,
    state: 'ACTIVE',
    allocatedAt: '2026-09-21T09:00:00.000Z',
    lastVerifiedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

function store(worktrees: WorktreeRecord[], leases: EndpointLease[]): ProxyRouteSource {
  return {
    listWorktrees: () => worktrees,
    listEndpointLeases: (query) => leases.filter((entry) => query?.states === undefined || query.states.includes(entry.state)),
  };
}

describe('buildProxyRoutes', () => {
  it('routes <service>.<slug>.wtm.localhost to the leased loopback port', () => {
    const routes = buildProxyRoutes(store([worktree()], [lease()]));
    expect(routes.get('web.feature-auth.wtm.localhost')).toEqual({
      hostname: 'web.feature-auth.wtm.localhost',
      host: '127.0.0.1',
      port: 23_671,
      worktreeId: 'worktree-1',
      service: 'web',
    });
  });

  it('one worktree with several endpoint leases gets one hostname per service', () => {
    const routes = buildProxyRoutes(store([worktree()], [
      lease({ id: 'l1', name: 'web', port: 23_671 }),
      lease({ id: 'l2', name: 'api', port: 23_672 }),
    ]));
    expect(routes.size).toBe(2);
    expect(routes.get('web.feature-auth.wtm.localhost')?.port).toBe(23_671);
    expect(routes.get('api.feature-auth.wtm.localhost')?.port).toBe(23_672);
  });

  it('ignores a RELEASED lease', () => {
    const routes = buildProxyRoutes(store([worktree()], [lease({ state: 'RELEASED' })]));
    expect(routes.size).toBe(0);
  });

  it('ignores a lease whose worktree record is missing', () => {
    const routes = buildProxyRoutes(store([], [lease()]));
    expect(routes.size).toBe(0);
  });

  it('ignores a non-tcp (udp) lease', () => {
    const routes = buildProxyRoutes(store([worktree()], [lease({ protocol: 'udp' })]));
    expect(routes.size).toBe(0);
  });

  it('ignores a lease whose host is not loopback', () => {
    const routes = buildProxyRoutes(store([worktree()], [lease({ host: '10.0.0.5' })]));
    expect(routes.size).toBe(0);
  });

  it('disambiguates two worktrees whose branches sanitize to the same slug', () => {
    const early = worktree({ id: 'w-early', numericId: 1, branch: 'fix/auth-bug' });
    const late = worktree({ id: 'w-late', numericId: 2, branch: 'fix-auth-bug' });
    const routes = buildProxyRoutes(store([early, late], [
      lease({ id: 'l1', worktreeId: 'w-early' }),
      lease({ id: 'l2', worktreeId: 'w-late' }),
    ]));
    expect(routes.has('web.fix-auth-bug.wtm.localhost')).toBe(true);
    const disambiguated = [...routes.keys()].find((key) => key !== 'web.fix-auth-bug.wtm.localhost');
    expect(disambiguated).toBeDefined();
    expect(routes.get(disambiguated as string)?.worktreeId).toBe('w-late');
  });

  it('is rebuilt fresh on every call, so a released lease disappears immediately', () => {
    const leases = [lease()];
    const dynamicStore: ProxyRouteSource = {
      listWorktrees: () => [worktree()],
      listEndpointLeases: (query) => leases.filter((entry) => query?.states === undefined || query.states.includes(entry.state)),
    };
    expect(buildProxyRoutes(dynamicStore).size).toBe(1);
    leases[0] = lease({ state: 'RELEASED' });
    expect(buildProxyRoutes(dynamicStore).size).toBe(0);
  });
});

describe('resolveProxyRoute', () => {
  it('looks a hostname up against the freshly-built table', () => {
    const source = store([worktree()], [lease()]);
    expect(resolveProxyRoute(source, 'web.feature-auth.wtm.localhost')?.port).toBe(23_671);
    expect(resolveProxyRoute(source, 'api.feature-auth.wtm.localhost')).toBeNull();
  });
});
