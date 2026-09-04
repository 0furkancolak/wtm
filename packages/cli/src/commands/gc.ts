import { applyGcPlan, type ApplyGcOptions, type GcItemResult, type GcPlan } from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';

export interface GcCommandInput extends Omit<ApplyGcOptions, 'apply'> {
  plan: GcPlan;
  apply?: boolean;
  workspaceId?: string;
}

export interface GcCommandResult {
  mode: 'dry-run' | 'apply';
  planned: number;
  excluded: number;
  items: Awaited<ReturnType<typeof applyGcPlan>>['items'];
}

export type GcCommandEnvelope = JsonEnvelope<GcCommandResult>;

export async function runGcCommand(input: GcCommandInput): Promise<GcCommandEnvelope> {
  const result = await applyGcPlan(input.plan, {
    guard: input.guard,
    ...(input.apply === true ? { apply: true } : {}),
    ...(input.lease === undefined ? {} : { lease: input.lease }),
    ...(input.journal === undefined ? {} : { journal: input.journal }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    ...(input.repositoryLease === undefined ? {} : { repositoryLease: input.repositoryLease }),
  });
  const failures = result.items.filter(
    (item): item is Extract<GcItemResult, { outcome: 'failed' | 'lease-contended' }> =>
      item.outcome === 'failed' || item.outcome === 'lease-contended',
  );
  const data: GcCommandResult = {
    mode: result.dryRun ? 'dry-run' : 'apply',
    planned: input.plan.candidates.length,
    excluded: input.plan.excluded.length,
    items: result.items,
  };
  const scope = { mode: 'local' as const, ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }) };
  if (failures.length === 0) {
    return { schemaVersion: 1, ok: true, command: 'gc', scope, data, warnings: [], errors: [] };
  }
  const errors = failures.map<WtmError>((failure) => ({
    code: failure.error.code,
    message: failure.error.message,
    severity: 'error',
    context: {
      storageObjectId: failure.storageObjectId,
      path: failure.path,
      phase: failure.phase,
      ...('quarantinePath' in failure ? { quarantinePath: failure.quarantinePath } : {}),
    },
  })) as [WtmError, ...WtmError[]];
  return { schemaVersion: 1, ok: false, command: 'gc', scope, data, warnings: [], errors };
}
