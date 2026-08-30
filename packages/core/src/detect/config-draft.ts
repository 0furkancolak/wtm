import type { WtmConfig } from '../config/schema';
import { parsePortRange } from '../runtime/endpoint-plan';
import type { PortRange } from '../state/store';
import type { DetectedService, WorkspaceDetection } from './service-detection';

/** One table WTM proposes to add, and the configuration path that decides whether it is new. */
export interface ConfigDraftBlock {
  /** The dotted path the table occupies, e.g. `ports.api`. */
  path: string;
  toml: string;
  /** True when the existing configuration already says something at that path. */
  present: boolean;
}

/** A port a repository asked for that the configuration's own range would never offer. */
export interface OutOfRangePort {
  service: string;
  preferred: number;
  /** The range in force, which the draft may not rewrite. */
  range: string;
  /** A range that would contain it, alongside everything already allocated. */
  suggested: string;
}

export interface ConfigDraft {
  blocks: ConfigDraftBlock[];
  /** Ports left out of the draft because the range in force cannot offer them. */
  outOfRange: OutOfRangePort[];
  /** The blocks the existing configuration does not have yet, as one appendable document. */
  additions: string;
  /** Every block, as the body of a configuration file that does not exist yet. */
  document: string;
}

export interface ConfigDraftInput {
  detection: WorkspaceDetection;
  /**
   * The parsed contents of the file the draft would be added to — that file alone, not the
   * resolved configuration. A block is skipped when that file already defines its table,
   * because TOML rejects a table defined twice.
   */
  existing?: WtmConfig;
}

/**
 * Turns what detection found into the TOML that says it.
 *
 * Detection that only ever lives in memory is detection nobody can see, argue with, or turn
 * off: the workspace behaves one way, the configuration explains none of it, and the next
 * person has to read WTM's source to find out why their app is on port 3000. So every fact
 * detection is willing to act on is written down as configuration first.
 */
export function renderConfigDraft(input: ConfigDraftInput): ConfigDraft {
  const services = input.detection.services;
  const blocks: ConfigDraftBlock[] = [];
  // A range already written is the workspace's decision, and a second [ports] table is a TOML
  // error — so when one is in force, the draft fits itself to it and says what it left out.
  const inForce = input.existing?.ports === undefined ? null : parsePortRange(input.existing.ports.range);
  const range = inForce === null ? portRange(services) : null;
  const outOfRange = inForce === null ? [] : excludedPorts(services, inForce);
  if (range !== null) {
    blocks.push(block('ports', hasPath(input.existing, ['ports']), [
      '# The band every endpoint is allocated from. It has to contain the preferred ports below,',
      '# and be wide enough for every worktree that runs at once.',
      '[ports]',
      `range = ${JSON.stringify(range)}`,
    ]));
  }

  for (const service of services) {
    if (service.port === null) continue;
    const excluded = outOfRange.find((port) => port.service === service.name);
    blocks.push(block(`ports.${service.name}`, hasPath(input.existing, ['ports', service.name]), [
      ...service.port.evidence.map(({ file, detail }) => `# ${file}: ${detail}`),
      ...(excluded === undefined ? [] : [
        `# It asked for ${excluded.preferred}, which [ports].range = "${excluded.range}" never offers.`,
        `# Widen the range to "${excluded.suggested}", then add: preferred = ${excluded.preferred}`,
      ]),
      `[ports.${service.name}]`,
      ...(service.port.preferred === null || excluded !== undefined
        ? []
        : [`preferred = ${service.port.preferred}`]),
    ]));
  }

  for (const service of services) {
    const environment = repositoryEnvironment(service);
    if (environment.length === 0) continue;
    blocks.push(block(`repos.${service.name}`, hasPath(input.existing, ['repos', service.name]), [
      `[repos.${service.name}]`,
      `path = ${JSON.stringify(service.path)}`,
      '',
      `[repos.${service.name}.environment]`,
      ...environment.flatMap(({ comment, name, value }) => [
        ...(comment === undefined ? [] : [`# ${comment}`]),
        `${name} = ${JSON.stringify(value)}`,
      ]),
    ]));
  }

  if (services.some((service) => service.cors.length > 0)) {
    blocks.push(block('cors', hasPath(input.existing, ['cors']), [
      '# The allowlist variables are named above, so WTM no longer looks for them itself.',
      '# Delete this to have a newly added repository detected the same way.',
      '[cors]',
      'enabled = false',
    ]));
  }

  return {
    blocks,
    outOfRange,
    additions: join(blocks.filter(({ present }) => !present)),
    document: join(blocks),
  };
}

function excludedPorts(services: readonly DetectedService[], range: PortRange): OutOfRangePort[] {
  const inForce = `${range.min}-${range.max}`;
  const wanted = services
    .map((service) => service.port?.preferred)
    .filter((port): port is number => typeof port === 'number');
  return services.flatMap((service) => {
    const preferred = service.port?.preferred;
    if (preferred === undefined || preferred === null) return [];
    if (preferred >= range.min && preferred <= range.max) return [];
    return [{
      service: service.name,
      preferred,
      range: inForce,
      suggested: `${Math.min(range.min, ...wanted)}-${Math.max(range.max, ...wanted.map((port) => port + 200))}`,
    }];
  });
}

interface EnvironmentEntry {
  name: string;
  value: string;
  comment?: string;
}

/** What a repository's own processes need told: its port, its allowlist, its neighbours. */
function repositoryEnvironment(service: DetectedService): EnvironmentEntry[] {
  const entries: EnvironmentEntry[] = [];
  if (service.port?.env != null) {
    entries.push({
      name: service.port.env,
      value: `{port.${service.name}}`,
      comment: 'The endpoint WTM allocated for this feature, in this repository.',
    });
  }
  for (const variable of service.cors) {
    entries.push({
      name: variable,
      value: '{cors.origins}',
      comment: 'Every origin this feature runs on, across the repositories that share its branch.',
    });
  }
  for (const link of service.links) {
    entries.push({
      name: link.variable,
      value: link.template,
      comment: `${link.evidence.file}: ${link.evidence.detail} points at ${link.target}`
        + `${link.confidence === 'medium' ? ' (matched by name — check it)' : ''}`,
    });
  }
  return entries;
}

/**
 * A band that contains every port the repositories asked for, with room to run several
 * worktrees at once. The default band starts at 20000, which no repository asks for — so a
 * detected `preferred = 3000` inside it would never be tried.
 */
function portRange(services: readonly DetectedService[]): string | null {
  const preferred = services
    .map((service) => service.port?.preferred)
    .filter((port): port is number => typeof port === 'number');
  if (preferred.length === 0) return null;
  const min = Math.max(1024, Math.floor(Math.min(...preferred) / 100) * 100);
  const max = Math.min(65_535, Math.max(Math.max(...preferred) + 200, min + 499));
  return `${min}-${max}`;
}

function block(path: string, present: boolean, lines: string[]): ConfigDraftBlock {
  return { path, present, toml: `${lines.join('\n')}\n` };
}

function join(blocks: readonly ConfigDraftBlock[]): string {
  return blocks.length === 0 ? '' : `${blocks.map(({ toml }) => toml.trimEnd()).join('\n\n')}\n`;
}

function hasPath(config: WtmConfig | undefined, path: readonly string[]): boolean {
  let current: unknown = config;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined;
}
