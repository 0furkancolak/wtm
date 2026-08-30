import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import {
  detectWorkspaceServices,
  parseWtmConfig,
  renderConfigDraft,
  type ManagedProcessRecord,
  type PreparedResource,
  type WtmConfig,
} from '@wtm/core';
import type { AdapterReport, WorktreeRuntime } from '@wtm/daemon';
import type { PlanDiagnostic } from './diagnostics';

type Change = PlanDiagnostic['changes'][number];

export interface ChangeInput {
  runtime: WorktreeRuntime;
  adapters: readonly AdapterReport[];
  resources: readonly PreparedResource[];
  /** Every managed process record of this workspace, and whether its pid is still alive. */
  processes: ReadonlyArray<{ record: ManagedProcessRecord; alive: boolean }>;
  /** The main root of every repository registered in this workspace. */
  repositoryRoots: readonly string[];
}

/**
 * What WTM would do next, and what it would leave alone.
 *
 * `wtm plan` returned nothing, so the one command whose whole purpose is to be read before
 * acting had nothing to read. Everything here is observed without changing it: the runtime is
 * resolved without leasing a port, resources are inspected rather than created, and detection
 * only reads the repositories.
 */
export async function planChanges(input: ChangeInput): Promise<Change[]> {
  return [
    ...await configChanges(input),
    ...endpointChanges(input.runtime),
    ...resourceChanges(input.resources),
    ...processChanges(input.processes),
    ...adapterChanges(input.adapters),
  ];
}

/**
 * The tables detection would add to `wtm.toml` — the same answer `wtm detect` gives, reached
 * from the registered repositories rather than by walking the disk again.
 */
async function configChanges(input: ChangeInput): Promise<Change[]> {
  const root = input.runtime.registration.workspace.root;
  const configPath = join(root, 'wtm.toml');
  let existing: WtmConfig | undefined;
  try {
    existing = parseWtmConfig(parse(await readFile(configPath, 'utf8')), configPath);
  } catch {
    // A workspace with no file of its own, or one that no longer parses; either way the draft
    // is still worth showing, and the configuration check reports a file that does not parse.
    existing = undefined;
  }
  let draft;
  try {
    draft = renderConfigDraft({
      detection: await detectWorkspaceServices({
        root,
        repositories: input.repositoryRoots.map((repository) => ({ root: repository })),
      }),
      ...(existing === undefined ? {} : { existing }),
    });
  } catch {
    return [];
  }

  const changes: Change[] = draft.blocks
    .filter((block) => !block.present)
    .map((block) => ({
      kind: 'config' as const,
      action: 'create' as const,
      target: block.path,
      reason: `Detection reads this from the repositories, and ${configPath} does not say it. `
        + 'Run `wtm detect --write` to add it.',
      details: { toml: block.toml },
    }));
  for (const port of draft.outOfRange) {
    changes.push({
      kind: 'config',
      action: 'update',
      target: 'ports.range',
      reason: `${port.service} asks for port ${port.preferred}, outside "${port.range}". `
        + `Widening it to "${port.suggested}" would give it that port.`,
      details: { service: port.service, preferred: port.preferred, suggested: port.suggested },
    });
  }
  return changes;
}

/** Which declared endpoints already hold a port for this feature, and which would take one. */
function endpointChanges(runtime: WorktreeRuntime): Change[] {
  return (runtime.observedEndpoints ?? []).map((endpoint) => endpoint.port === null
    ? {
      kind: 'endpoint' as const,
      action: 'create' as const,
      target: endpoint.name,
      reason: 'No port is leased for this feature yet; the next task to run here would take one.',
    }
    : {
      kind: 'endpoint' as const,
      action: 'none' as const,
      target: endpoint.name,
      reason: endpoint.fixed
        ? `Fixed at ${endpoint.port} by the configuration, so nothing is leased.`
        : `Already leased at ${endpoint.port} for every worktree of this feature.`,
      details: { port: endpoint.port },
    });
}

function resourceChanges(resources: readonly PreparedResource[]): Change[] {
  return resources.map((resource) => {
    if (resource.state === 'ready') {
      return {
        kind: 'resource' as const,
        action: 'none' as const,
        target: resource.name,
        reason: 'Declared and in place.',
        details: { path: resource.path },
      };
    }
    return {
      kind: 'resource' as const,
      action: 'create' as const,
      target: resource.name,
      reason: resource.state === 'degraded'
        ? `${resource.detail ?? 'It could not be created.'} The next task here will try again.`
        : 'Declared and not there; the next task run here creates it.',
      details: { path: resource.path, policy: resource.policy },
    };
  });
}

/**
 * A record that says RUNNING for a process the operating system no longer knows is not a
 * running task; it is a row the daemon will retire. Saying so is the difference between `ps`
 * looking wrong and `ps` being explained.
 */
function processChanges(processes: ChangeInput['processes']): Change[] {
  return processes
    .filter(({ record }) => record.state === 'RUNNING')
    .map(({ record, alive }) => alive
      ? {
        kind: 'process' as const,
        action: 'none' as const,
        target: record.taskName,
        reason: `Running as pid ${record.pid}.`,
        details: { pid: record.pid },
      }
      : {
        kind: 'process' as const,
        action: 'remove' as const,
        target: record.taskName,
        reason: `The record says pid ${record.pid} is running and the process is gone. `
          + 'The daemon retires the record when it next reconciles.',
        details: { pid: record.pid },
      });
}

/** Only the adapters that recognized the worktree and were then left out, and why. */
function adapterChanges(adapters: readonly AdapterReport[]): Change[] {
  return adapters
    .filter((adapter) => !adapter.active)
    .map((adapter) => ({
      kind: 'adapter' as const,
      action: 'none' as const,
      target: adapter.id,
      reason: adapter.reason,
    }));
}
