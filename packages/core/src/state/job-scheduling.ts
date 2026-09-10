import type { JobState, JobWaitingReason } from '@wtm/protocol';
import { memoryAllowsClaim, type JobMemoryAdmission } from './job-memory';

export interface JobSchedulingEntry {
  jobId: string;
  state: JobState;
  slotHeld: boolean;
  worktreeBusy: boolean;
  memoryEstimateBytes?: number | null;
}

/** The snapshot is in FIFO order and admission bounds its queued/held entries to 128. */
export function jobWaitingReasons(
  entries: readonly JobSchedulingEntry[],
  maxConcurrent: number,
  memory?: JobMemoryAdmission,
): ReadonlyMap<string, JobWaitingReason> {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('Invalid concurrency limit');
  const full = entries.reduce((held, entry) => held + Number(entry.slotHeld), 0) >= maxConcurrent;
  const head = entries.find((entry) => entry.state === 'QUEUED');
  const heldEstimates = entries.filter((entry) => entry.slotHeld).map((entry) => entry.memoryEstimateBytes);
  const reasons = new Map<string, JobWaitingReason>();
  for (const entry of entries) {
    if (entry.state !== 'QUEUED') continue;
    reasons.set(entry.jobId, full ? 'concurrency'
      : entry !== head ? 'fifo'
        : entry.worktreeBusy ? 'worktree_busy'
          : memory !== undefined && !memoryAllowsClaim(entry.memoryEstimateBytes, heldEstimates, memory)
            ? 'memory_budget' : 'dispatch_pending');
  }
  return reasons;
}
