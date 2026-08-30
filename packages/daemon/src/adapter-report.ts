import { detectBuiltInAdapters, type AdapterActivation } from '@wtm/adapters';
import type { AdapterContext, DoctorCheck } from '@wtm/protocol';

/** One built-in adapter that recognized this worktree, and what it contributes. */
export interface AdapterReport {
  id: string;
  /** False when the adapter recognized the worktree but was excluded from the plan. */
  active: boolean;
  provides: string[];
  requires: string[];
  /** The task names it offers, empty when it was excluded before it could be asked. */
  tasks: string[];
  /** Why it is in this state, in the terms the exclusion rules are written in. */
  reason: string;
}

export interface AdapterInspection {
  adapters: AdapterReport[];
  /** Ambiguities and unmet capabilities, exactly as the registry reports them. */
  findings: DoctorCheck[];
}

/**
 * Which adapters recognized this worktree, which of them are in force, and why the rest are
 * not.
 *
 * Detection already decides all of this on every task resolution — two package managers in one
 * repository is the common case, and one of them silently wins. `wtm doctor` reported
 * `adapters: unknown` regardless, and `wtm explain` said nothing at all, so the one question a
 * person asks when the wrong command runs had no answer anywhere.
 */
export async function inspectAdapters(context: AdapterContext): Promise<AdapterInspection> {
  const graph = await detectBuiltInAdapters(context);
  const activeIds = new Set(graph.active.map(({ metadata }) => metadata.id));
  const adapters: AdapterReport[] = [];
  for (const activation of graph.detected) {
    const active = activeIds.has(activation.metadata.id);
    adapters.push({
      id: activation.metadata.id,
      active,
      provides: [...activation.metadata.provides],
      requires: [...(activation.metadata.requires ?? [])],
      tasks: active ? await taskNames(activation, context) : [],
      reason: active
        ? `Detected in this worktree${evidence(activation)}.`
        : exclusion(activation.metadata.id, graph.findings),
    });
  }
  return { adapters: adapters.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)), findings: graph.findings };
}

async function taskNames(activation: AdapterActivation, context: AdapterContext): Promise<string[]> {
  try {
    return Object.keys((await activation.adapter.plan(context)).tasks).sort();
  } catch {
    // A plan that cannot be read does not make the adapter's detection untrue.
    return [];
  }
}

function evidence(activation: AdapterActivation): string {
  const found = activation.detection.evidence.map(({ value }) => value).filter((value) => value.length > 0);
  return found.length === 0 ? '' : ` by ${found.join(', ')}`;
}

function exclusion(id: string, findings: readonly DoctorCheck[]): string {
  const finding = findings.find((check) => check.context?.['adapter'] === id
    || asStrings(check.context?.['providers']).includes(id));
  return finding?.message ?? 'Detected, but excluded from the plan.';
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
