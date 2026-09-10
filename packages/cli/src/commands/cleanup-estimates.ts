import { resolve } from 'node:path';
import { mountBoundaryReaderFor, selectPlatformRuntime } from '@wtm/platform';
import {
  measureWorktreeReclaimable,
  reclaimableWorktreeResourcePaths,
  resolveTemplate,
  type TemplateContext,
  type WorktreeReclaimableMeasurement,
  type WtmConfig,
} from '@wtm/core';

export interface CleanupEstimateCandidate {
  path: string;
  loadConfig(): Promise<{ config: WtmConfig; context: TemplateContext }>;
}

/** One cooperative IO budget for the whole report; candidates never spawn parallel walks. */
export async function measureCleanupCandidates(
  candidates: readonly CleanupEstimateCandidate[],
  options: { maxEntries?: number; maxDurationMs?: number;
    readMountBoundaries?: Parameters<typeof measureWorktreeReclaimable>[0]['readMountBoundaries'];
  } = {},
): Promise<Map<string, WorktreeReclaimableMeasurement>> {
  const deadline = performance.now() + (options.maxDurationMs ?? 2000);
  let remaining = options.maxEntries ?? 20_000;
  const measurements = new Map<string, WorktreeReclaimableMeasurement>();
  const readMountBoundaries = options.readMountBoundaries ?? mountBoundaryReaderFor(selectPlatformRuntime().id);
  for (const candidate of [...candidates].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    if (performance.now() >= deadline || remaining <= 0) {
      measurements.set(candidate.path, unavailableEstimate(performance.now() >= deadline ? 'time-budget' : 'entry-budget', 'partial'));
      continue;
    }
    try {
      const { config, context } = await candidate.loadConfig();
      const resources = config.resources ?? {};
      const ownedPaths = new Set(reclaimableWorktreeResourcePaths({ worktreeRoot: candidate.path, resources, context }));
      // Use the removal policy's own classification. Unresolved retained paths refuse the
      // estimate instead of silently counting bytes that another worktree may still need.
      const excludedPaths = Object.values(resources)
        .map((resource) => resolve(candidate.path, resolveTemplate(resource.path, context)))
        .filter((path) => !ownedPaths.has(path));
      const measurement = await measureWorktreeReclaimable({ root: candidate.path, excludedPaths, maxEntries: remaining, deadline, readMountBoundaries });
      remaining = Math.max(0, remaining - measurement.entries);
      measurements.set(candidate.path, measurement);
    } catch {
      measurements.set(candidate.path, unavailableEstimate('unreadable'));
    }
  }
  return measurements;
}

function unavailableEstimate(
  reason: WorktreeReclaimableMeasurement['reason'],
  status: 'partial' | 'unavailable' = 'unavailable',
): WorktreeReclaimableMeasurement {
  return {
    status, estimatedBytes: null, observedExclusiveBytes: 0, entries: 0,
    excluded: { hardlinks: 0, symlinks: 0, policyPaths: 0, crossDevice: 0, mounts: 0 },
    reason, basis: 'exclusive-file-allocation-estimate',
  };
}
