import { WtmConfigError, type PortConfig, type PortsConfig } from '../config/schema';
import { allocateStableEndpoint } from './endpoints';
import type {
  EndpointAvailabilityProbe,
  EndpointLease,
  PortRange,
  StateStore,
} from '../state/store';

/** Where an endpoint listens when the configuration does not say otherwise. */
export const defaultEndpointHost = '127.0.0.1';
/** The origin host WTM publishes to browsers, which do not treat 127.0.0.1 and localhost alike. */
export const defaultOriginHost = 'localhost';

export interface EndpointPlanInput {
  ports?: PortsConfig;
  /**
   * The worktree an endpoint is leased to when the feature does not hold one yet. Later
   * worktrees in the same group read that lease rather than taking a port of their own.
   */
  worktreeId: string;
  /**
   * Every worktree that shares this feature's endpoints, this one included. A feature is
   * usually a branch checked out across several repositories: the API and the web app that
   * belong to it must agree on which port the API listens on, so they resolve one set of
   * endpoints between them instead of one set each.
   */
  groupWorktreeIds: readonly string[];
  /** The worktree's stable number, which the `offset` strategy counts from. */
  index: number;
  host?: string;
}

export interface ResolvedEndpoints {
  /** Port per configured name, for `{port.<name>}`. */
  ports: Record<string, number>;
  /** Variables each endpoint asked to be published under, before the workspace's own env. */
  env: Record<string, string>;
  /** Browser origins for every endpoint that serves one, in configuration order. */
  origins: string[];
  /** The leases backing the ports above. Fixed ports are not leased and do not appear. */
  leases: EndpointLease[];
}

const reservedPortKeys = new Set(['strategy', 'range']);

/**
 * Resolves the workspace's `[ports]` block into concrete ports for one worktree.
 *
 * Two worktrees of the same repository get different ports for the same name, which is what
 * lets two branches run at once. Worktrees of *different* repositories that belong to the same
 * feature get the same port for the same name, which is what lets the web app of a feature
 * reach the API of that same feature without either of them being configured by hand.
 */
export function resolveEndpoints(
  store: Pick<StateStore, 'allocateEndpoint' | 'listEndpointLeases'>,
  input: EndpointPlanInput,
  probe?: EndpointAvailabilityProbe,
): ResolvedEndpoints {
  const resolved: ResolvedEndpoints = { ports: {}, env: {}, origins: [], leases: [] };
  if (input.ports === undefined) return resolved;
  const range = parsePortRange(input.ports.range);
  const host = input.host ?? defaultEndpointHost;

  for (const [name, raw] of Object.entries(input.ports)) {
    if (reservedPortKeys.has(name)) continue;
    const port = endpointPort(store, name, portConfig(name, raw), { ...input, host, range }, probe, resolved);
    resolved.ports[name] = port;
  }
  return resolved;
}

function endpointPort(
  store: Pick<StateStore, 'allocateEndpoint' | 'listEndpointLeases'>,
  name: string,
  config: PortConfig,
  input: EndpointPlanInput & { host: string; range: PortRange },
  probe: EndpointAvailabilityProbe | undefined,
  resolved: ResolvedEndpoints,
): number {
  const port = config.strategy === 'fixed'
    // A fixed port is the workspace's decision, not WTM's. Leasing it would let the allocator
    // move it the moment something else holds it, which is the opposite of what was asked for.
    ? fixedPort(name, config)
    : leasedPort(store, name, config, input, probe, resolved);
  if (config.env !== undefined) resolved.env[config.env] = String(port);
  if (config.origin !== false) resolved.origins.push(`http://${originHost(input.host)}:${port}`);
  return port;
}

function fixedPort(name: string, config: PortConfig): number {
  if (config.port === undefined) {
    throw new WtmConfigError(`Port ${name} uses the fixed strategy without a port.`, { port: name });
  }
  return config.port;
}

function leasedPort(
  store: Pick<StateStore, 'allocateEndpoint' | 'listEndpointLeases'>,
  name: string,
  config: PortConfig,
  input: EndpointPlanInput & { host: string; range: PortRange },
  probe: EndpointAvailabilityProbe | undefined,
  resolved: ResolvedEndpoints,
): number {
  const shared = store.listEndpointLeases({
    worktreeIds: input.groupWorktreeIds,
    name,
    states: ['ACTIVE'],
  })[0];
  if (shared !== undefined) {
    resolved.leases.push(shared);
    return shared.port;
  }

  const preferred = preferredPort(name, config, input.index, input.range);
  const lease = allocateStableEndpoint(store as StateStore, {
    worktreeId: input.worktreeId,
    name,
    protocol: 'tcp',
    host: input.host,
    portRange: input.range,
    ...(preferred === undefined ? {} : { preferredPort: preferred }),
  }, probe);
  resolved.leases.push(lease);
  return lease.port;
}

/**
 * The port the allocator tries first. It is a preference rather than a guarantee: a port
 * another process already holds is stepped over, because a worktree that cannot start is
 * worse than a worktree that starts one port along.
 */
function preferredPort(name: string, config: PortConfig, index: number, range: PortRange): number | undefined {
  if (config.preferred === undefined) return undefined;
  // The allocator only tries a preference that falls inside the range, so one that does not is
  // a preference that never happens. Saying nothing about it is how a workspace ends up
  // wondering why `preferred = 3000` put it on port 20000.
  if (config.preferred < range.min || config.preferred > range.max) {
    throw new WtmConfigError(
      `Port ${name} prefers ${config.preferred}, which is outside the range ${range.min}-${range.max}.`,
      {
        port: name,
        preferred: config.preferred,
        range: `${range.min}-${range.max}`,
        action: 'Widen [ports].range to contain it, or remove the preferred port.',
      },
    );
  }
  if (config.strategy !== 'offset') return config.preferred;
  const candidate = config.preferred + (config.stride ?? 1) * Math.max(0, index - 1);
  return candidate > range.max ? undefined : candidate;
}

function portConfig(name: string, value: unknown): PortConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WtmConfigError(`Port ${name} must be a table.`, { port: name });
  }
  return value as PortConfig;
}

/**
 * Browsers compare origins by string, and `127.0.0.1` and `localhost` are different strings.
 * An allowlist built from the address a server binds to would therefore reject the address a
 * person actually types, so the loopback address is published under the name they type.
 */
function originHost(host: string): string {
  return host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ? defaultOriginHost : host;
}

/** Parses `"20000-50000"`, the only range spelling the configuration accepts. */
export function parsePortRange(range: string | undefined): PortRange {
  if (range === undefined) return { min: 20_000, max: 50_000 };
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(range.trim());
  const min = Number(match?.[1]);
  const max = Number(match?.[2]);
  if (match === null || min < 1 || max > 65_535 || min > max) {
    throw new WtmConfigError(`Port range is not a valid range: ${range}`, { range });
  }
  return { min, max };
}

/** One declared endpoint, and the lease behind it — or the absence of one. */
export interface ObservedEndpoint {
  name: string;
  /** The port in force, or `null` when nothing has been leased for this name yet. */
  port: number | null;
  /** True when the configuration names the port itself, so no lease is ever taken. */
  fixed: boolean;
  /** The variable the endpoint publishes itself under, when it asks for one. */
  env?: string;
  origin?: string;
}

/**
 * What `[ports]` resolves to *without* allocating anything.
 *
 * `resolveEndpoints` leases a port for every name that does not have one, which is right when
 * something is about to be run and wrong when the question is only what would happen. `wtm
 * plan` must be able to say "this feature has no port for `api` yet" without that ceasing to
 * be true by the act of asking.
 */
export function resolveExistingEndpoints(
  store: Pick<StateStore, 'listEndpointLeases'>,
  input: Pick<EndpointPlanInput, 'ports' | 'groupWorktreeIds' | 'host'>,
): { endpoints: ObservedEndpoint[]; resolved: ResolvedEndpoints } {
  const resolved: ResolvedEndpoints = { ports: {}, env: {}, origins: [], leases: [] };
  const endpoints: ObservedEndpoint[] = [];
  if (input.ports === undefined) return { endpoints, resolved };
  const host = input.host ?? defaultEndpointHost;

  for (const [name, raw] of Object.entries(input.ports)) {
    if (reservedPortKeys.has(name)) continue;
    const config = portConfig(name, raw);
    const lease = config.strategy === 'fixed' ? undefined : store.listEndpointLeases({
      worktreeIds: input.groupWorktreeIds,
      name,
      states: ['ACTIVE'],
    })[0];
    const port = config.strategy === 'fixed' ? config.port ?? null : lease?.port ?? null;
    if (lease !== undefined) resolved.leases.push(lease);
    const origin = port === null || config.origin === false
      ? undefined
      : `http://${originHost(host)}:${port}`;
    if (port !== null) {
      resolved.ports[name] = port;
      if (config.env !== undefined) resolved.env[config.env] = String(port);
      if (origin !== undefined) resolved.origins.push(origin);
    }
    endpoints.push({
      name,
      port,
      fixed: config.strategy === 'fixed',
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(origin === undefined ? {} : { origin }),
    });
  }
  return { endpoints, resolved };
}
