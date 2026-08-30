import type { PreparedResource, Provenance } from '@wtm/core';
import type { AdapterReport, WorktreeRuntime } from '@wtm/daemon';
import type { ExplainDiagnostic } from './diagnostics';

type Decision = ExplainDiagnostic['decisions'][number];
type JsonValue = Decision['value'];

export interface DecisionInput {
  runtime: WorktreeRuntime;
  adapters: readonly AdapterReport[];
  resources: readonly PreparedResource[];
  /** The environment a task in this worktree is started with, already layered and rendered. */
  environment: Record<string, string>;
}

/** Configuration WTM supplies rather than reads, named so it cannot be mistaken for a file. */
const wtmSource = 'wtm:derived';

/**
 * Every choice in force in this worktree, and where it came from.
 *
 * `wtm explain` returned an empty list, which is the answer that costs the most: the whole
 * point of resolving configuration from four layers, detecting adapters, and deriving an
 * environment is that somebody can later ask why `PORT` is 4001 and be told. The facts were
 * all being computed already and then dropped — provenance was resolved and discarded, and the
 * adapter graph was recomputed on every task without ever being reported.
 */
export function explainDecisions(input: DecisionInput): Decision[] {
  return [
    ...configDecisions(input.runtime),
    ...environmentDecisions(input),
    ...adapterDecisions(input.adapters),
    ...taskDecisions(input),
    ...resourceDecisions(input),
  ];
}

/** Every configuration leaf in force, with the file and line that settled it. */
function configDecisions(runtime: WorktreeRuntime): Decision[] {
  const decisions: Decision[] = [];
  for (const [key, provenance] of runtime.provenance) {
    const top = key.split('.')[0] ?? '';
    // Tasks and resources are explained as themselves below, where their whole table is
    // visible; splitting them into one decision per leaf says less, not more.
    if (top === 'tasks' || top === 'resources' || top === 'environment' || top === 'repos') continue;
    decisions.push({
      kind: 'config',
      key,
      value: toJson(readPath(runtime.config, key)),
      provenance,
      reason: reasonFor(provenance),
    });
  }
  return decisions;
}

/**
 * The environment a task actually receives, one variable at a time, attributed to the layer
 * that won it. This is the question people ask — not what `[environment]` says, but what
 * `PORT` ends up being once the repository's own table has had its say.
 */
function environmentDecisions(input: DecisionInput): Decision[] {
  const { runtime } = input;
  const repo = runtime.repoEnvironment ?? {};
  const workspace = runtime.config.environment ?? {};
  return Object.entries(input.environment).map(([name, value]) => {
    if (Object.hasOwn(repo, name)) {
      const key = repoProvenanceKey(runtime.provenance, name);
      return {
        kind: 'config' as const,
        key: `env.${name}`,
        value: toJson(value),
        provenance: key === undefined ? { source: wtmSource } : runtime.provenance.get(key) as Provenance,
        reason: `Set by this repository's own [repos.*.environment], which is layered over the workspace's.`,
      };
    }
    if (Object.hasOwn(workspace, name)) {
      return {
        kind: 'config' as const,
        key: `env.${name}`,
        value: toJson(value),
        provenance: runtime.provenance.get(`environment.${name}`) ?? { source: wtmSource },
        reason: 'Set by the workspace [environment] table.',
      };
    }
    return {
      kind: 'config' as const,
      key: `env.${name}`,
      value: toJson(value),
      provenance: { source: wtmSource },
      reason: derivedReason(runtime, name),
    };
  });
}

/** Which piece of WTM's own machinery published a variable nothing in the files declares. */
function derivedReason(runtime: WorktreeRuntime, name: string): string {
  const endpoint = Object.entries(runtime.config.ports ?? {})
    .find(([key, value]) => key !== 'strategy' && key !== 'range'
      && typeof value === 'object' && value !== null && (value as { env?: unknown }).env === name);
  if (endpoint !== undefined) {
    return `The port leased for [ports.${endpoint[0]}], published under the name that table asks for.`;
  }
  if (runtime.endpoints.origins.length > 0 && runtime.automaticEnvironment[name] === runtime.endpoints.origins.join(',')) {
    return 'The CORS allowlist WTM built from this feature\'s own origins.';
  }
  return 'Derived by WTM for this worktree.';
}

function adapterDecisions(adapters: readonly AdapterReport[]): Decision[] {
  return adapters.map((adapter) => ({
    kind: 'adapter' as const,
    key: adapter.id,
    value: toJson({
      active: adapter.active,
      provides: adapter.provides,
      requires: adapter.requires,
      tasks: adapter.tasks,
    }),
    provenance: { source: wtmSource },
    reason: adapter.reason,
  }));
}

/** Every task that can be run here, and whether the workspace or an adapter defined it. */
function taskDecisions(input: DecisionInput): Decision[] {
  const tasks = input.runtime.config.tasks ?? {};
  const byAdapter = new Map<string, string>();
  for (const adapter of input.adapters) {
    for (const name of adapter.tasks) if (!byAdapter.has(name)) byAdapter.set(name, adapter.id);
  }
  return Object.entries(tasks).map(([name, task]) => {
    const declared = firstProvenance(input.runtime.provenance, `tasks.${name}.`);
    const adapter = byAdapter.get(name);
    return {
      kind: 'task' as const,
      key: name,
      value: toJson(task),
      provenance: declared ?? { source: adapter === undefined ? wtmSource : `adapter:${adapter}` },
      reason: declared !== undefined
        ? adapter === undefined
          ? 'Defined by the workspace configuration.'
          : `Defined by the workspace configuration, which wins over the ${adapter} adapter's task of the same name.`
        : adapter === undefined
          ? 'Contributed by a detected adapter.'
          : `Contributed by the ${adapter} adapter, because the configuration does not define it.`,
    };
  });
}

function resourceDecisions(input: DecisionInput): Decision[] {
  return input.resources.map((resource) => ({
    kind: 'resource' as const,
    key: resource.name,
    value: toJson({ path: resource.path, policy: resource.policy, state: resource.state }),
    provenance: input.runtime.provenance.get(`resources.${resource.name}.path`) ?? { source: wtmSource },
    reason: resource.detail ?? (resource.state === 'ready'
      ? 'Declared by [resources], and in place.'
      : `Declared by [resources]; this worktree's copy is ${resource.state}.`),
  }));
}

/** The provenance of the first leaf under a table, which is the table's own file and line. */
function firstProvenance(provenance: Map<string, Provenance>, prefix: string): Provenance | undefined {
  let best: Provenance | undefined;
  for (const [key, value] of provenance) {
    if (!key.startsWith(prefix)) continue;
    if (best === undefined || (value.line ?? Infinity) < (best.line ?? Infinity)) best = value;
  }
  return best;
}

function repoProvenanceKey(provenance: Map<string, Provenance>, name: string): string | undefined {
  const suffix = `.environment.${name}`;
  for (const key of provenance.keys()) {
    if (key.startsWith('repos.') && key.endsWith(suffix)) return key;
  }
  return undefined;
}

function reasonFor(provenance: Provenance): string {
  return provenance.source === 'built-in'
    ? 'WTM\'s own default, because nothing in the configuration says otherwise.'
    : `Declared in ${provenance.source}${provenance.line === undefined ? '' : ` line ${provenance.line}`}.`;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The schema accepts JSON, and a configuration value is JSON by construction. */
function toJson(value: unknown): JsonValue {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as JsonValue;
}
