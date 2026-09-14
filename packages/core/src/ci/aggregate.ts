import type { CiRun } from '@wtm/protocol';

export type CiVerdict = 'none' | 'pending' | 'success' | 'failure' | 'cancelled';

const succeeding = new Set(['success', 'skipped', 'neutral']);

/** Any conclusion of a completed run or job that is neither a success nor a cancellation. */
export function isFailingConclusion(conclusion: string | null): boolean {
  return conclusion === null || (!succeeding.has(conclusion) && conclusion !== 'cancelled');
}

export function aggregateCiRuns(runs: readonly CiRun[]): CiVerdict {
  if (runs.length === 0) return 'none';
  if (runs.some(({ status }) => status !== 'completed')) return 'pending';
  if (runs.some(({ conclusion }) => isFailingConclusion(conclusion))) return 'failure';
  if (runs.some(({ conclusion }) => conclusion === 'cancelled')) return 'cancelled';
  return 'success';
}
