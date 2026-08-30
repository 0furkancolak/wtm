import { describe, expect, it } from 'bun:test';
import { resolveEndpoints, resolveExistingEndpoints, parsePortRange } from '../endpoint-plan';
import { WtmConfigError } from '../../config/schema';
import type {
  EndpointAvailabilityProbe,
  EndpointLease,
  EndpointLeaseQuery,
  EndpointRequest,
  StateStore,
} from '../../state/store';

/** Just enough store to exercise allocation: leases keyed by worktree and name, ports unique. */
function createLeaseStore(): Pick<StateStore, 'allocateEndpoint' | 'listEndpointLeases'> {
  const leases: EndpointLease[] = [];
  return {
    allocateEndpoint(input: EndpointRequest, probe?: EndpointAvailabilityProbe): EndpointLease {
      const existing = leases.find((lease) =>
        lease.worktreeId === input.worktreeId && lease.name === input.name);
      if (existing !== undefined) return existing;
      const candidates = [
        ...(input.preferredPort === undefined ? [] : [input.preferredPort]),
        ...Array.from({ length: input.portRange.max - input.portRange.min + 1 },
          (_value, offset) => input.portRange.min + offset),
      ];
      const port = candidates.find((candidate) =>
        !leases.some((lease) => lease.port === candidate && lease.state === 'ACTIVE')
        && (probe?.({ protocol: input.protocol, host: input.host, port: candidate }) ?? true));
      if (port === undefined) throw new Error(`No available ${input.protocol} endpoint on ${input.host} in range ${input.portRange.min}-${input.portRange.max}`);
      const lease: EndpointLease = {
        id: `lease-${leases.length + 1}`,
        worktreeId: input.worktreeId,
        name: input.name,
        protocol: input.protocol,
        host: input.host,
        port,
        state: 'ACTIVE',
        allocatedAt: '2026-01-01T00:00:00.000Z',
        lastVerifiedAt: '2026-01-01T00:00:00.000Z',
      };
      leases.push(lease);
      return lease;
    },
    listEndpointLeases(query: EndpointLeaseQuery = {}): EndpointLease[] {
      return leases.filter((lease) =>
        (query.worktreeIds === undefined || query.worktreeIds.includes(lease.worktreeId))
        && (query.name === undefined || query.name === lease.name)
        && (query.states === undefined || query.states.includes(lease.state)));
    },
  };
}

const alwaysFree: EndpointAvailabilityProbe = () => true;

describe('endpoint planning', () => {
  it('gives every configured name a port inside the range', () => {
    const resolved = resolveEndpoints(createLeaseStore(), {
      ports: { range: '4100-4199', api: {}, web: { preferred: 4150 } },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, alwaysFree);

    expect(resolved.ports.web).toBe(4150);
    expect(resolved.ports.api).toBeGreaterThanOrEqual(4100);
    expect(resolved.ports.api).toBeLessThanOrEqual(4199);
  });

  it('gives two worktrees of one feature the same port for one name', () => {
    const store = createLeaseStore();
    const ports = { range: '4100-4199', api: { preferred: 4100 } };
    const api = resolveEndpoints(store, {
      ports, worktreeId: 'api-feature', groupWorktreeIds: ['api-feature', 'web-feature'], index: 2,
    }, alwaysFree);
    const web = resolveEndpoints(store, {
      ports, worktreeId: 'api-feature', groupWorktreeIds: ['api-feature', 'web-feature'], index: 2,
    }, alwaysFree);

    // The web repository's worktree reads the API's port rather than taking one of its own,
    // which is the only way `{port.api}` can mean anything in the web app's environment.
    expect(web.ports.api).toBe(api.ports.api as number);
  });

  it('refuses a preferred port the range would never offer', () => {
    // The allocator only tries a preference inside the range, so silence here is a workspace
    // that asked for 3000, was given 20000, and has nothing to read that explains it.
    expect(() => resolveEndpoints(createLeaseStore(), {
      ports: { range: '20000-50000', api: { preferred: 3000 } },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, alwaysFree)).toThrow('outside the range 20000-50000');
  });

  it('gives two features different ports for the same name', () => {
    const store = createLeaseStore();
    const ports = { range: '4100-4199', api: { preferred: 4100 } };
    const first = resolveEndpoints(store, {
      ports, worktreeId: 'feature-one', groupWorktreeIds: ['feature-one'], index: 1,
    }, alwaysFree);
    const second = resolveEndpoints(store, {
      ports, worktreeId: 'feature-two', groupWorktreeIds: ['feature-two'], index: 2,
    }, alwaysFree);

    expect(second.ports.api).not.toBe(first.ports.api as number);
  });

  it('publishes each port under the variable it names, and as an origin', () => {
    const resolved = resolveEndpoints(createLeaseStore(), {
      ports: {
        range: '4100-4199',
        web: { preferred: 4100, env: 'PORT' },
        database: { strategy: 'fixed', port: 5432, origin: false },
      },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, alwaysFree);

    expect(resolved.env).toEqual({ PORT: '4100' });
    expect(resolved.ports.database).toBe(5432);
    expect(resolved.origins).toEqual(['http://localhost:4100']);
  });

  it('counts the offset strategy from the worktree number', () => {
    const resolved = resolveEndpoints(createLeaseStore(), {
      ports: { range: '4100-4199', web: { strategy: 'offset', preferred: 4100, stride: 10 } },
      worktreeId: 'worktree-c',
      groupWorktreeIds: ['worktree-c'],
      index: 3,
    }, alwaysFree);

    expect(resolved.ports.web).toBe(4120);
  });

  it('steps over a port another process already holds', () => {
    const resolved = resolveEndpoints(createLeaseStore(), {
      ports: { range: '4100-4199', web: { preferred: 4100 } },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, (candidate) => candidate.port !== 4100);

    expect(resolved.ports.web).toBe(4101);
  });

  it('rejects a fixed endpoint that names no port', () => {
    expect(() => resolveEndpoints(createLeaseStore(), {
      ports: { web: { strategy: 'fixed' } },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, alwaysFree)).toThrow(WtmConfigError);
  });

  it('resolves nothing when the workspace configures no endpoints', () => {
    expect(resolveEndpoints(createLeaseStore(), {
      worktreeId: 'worktree-a', groupWorktreeIds: ['worktree-a'], index: 1,
    }, alwaysFree)).toEqual({ ports: {}, env: {}, origins: [], leases: [] });
  });
});

describe('port range parsing', () => {
  it('reads the documented spelling', () => {
    expect(parsePortRange('3000-3999')).toEqual({ min: 3000, max: 3999 });
  });

  it('falls back to the built-in range when none is configured', () => {
    expect(parsePortRange(undefined)).toEqual({ min: 20_000, max: 50_000 });
  });

  it('rejects a range that is not one', () => {
    for (const range of ['3000', '3999-3000', '0-100', '1-70000', 'three-four']) {
      expect(() => parsePortRange(range)).toThrow(WtmConfigError);
    }
  });
});

describe('observing endpoints without allocating', () => {
  it('reports a name with no lease as having no port, and takes none', () => {
    const store = createLeaseStore();

    const observed = resolveExistingEndpoints(store, {
      ports: { range: '4100-4199', api: { preferred: 4100 } },
      groupWorktreeIds: ['worktree-a'],
    });

    expect(observed.endpoints).toEqual([{ name: 'api', port: null, fixed: false }]);
    expect(observed.resolved.ports).toEqual({});
    expect(store.listEndpointLeases()).toEqual([]);
  });

  it('reports the port the feature already holds, whichever worktree took it', () => {
    const store = createLeaseStore();
    resolveEndpoints(store, {
      ports: { range: '4100-4199', api: { preferred: 4100, env: 'PORT' } },
      worktreeId: 'worktree-a',
      groupWorktreeIds: ['worktree-a'],
      index: 1,
    }, alwaysFree);

    const observed = resolveExistingEndpoints(store, {
      ports: { range: '4100-4199', api: { preferred: 4100, env: 'PORT' } },
      groupWorktreeIds: ['worktree-a', 'worktree-b'],
    });

    expect(observed.endpoints).toEqual([
      { name: 'api', port: 4100, fixed: false, env: 'PORT', origin: 'http://localhost:4100' },
    ]);
    expect(observed.resolved.env).toEqual({ PORT: '4100' });
    expect(observed.resolved.origins).toEqual(['http://localhost:4100']);
  });

  it('reports a fixed port as fixed, because nothing is ever leased for one', () => {
    const observed = resolveExistingEndpoints(createLeaseStore(), {
      ports: { range: '4100-4199', db: { strategy: 'fixed', port: 5432, origin: false } },
      groupWorktreeIds: ['worktree-a'],
    });

    expect(observed.endpoints).toEqual([{ name: 'db', port: 5432, fixed: true }]);
    expect(observed.resolved.ports).toEqual({ db: 5432 });
    expect(observed.resolved.origins).toEqual([]);
  });
});
