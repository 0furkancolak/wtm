/** A point-in-time observation; reservations, not OS allocations, are atomic in SQLite. */
export interface JobMemoryAdmission {
  budgetBytes: number;
  reserveBytes: number;
  availableBytes: number | null;
  /** Physical memory capped by the daemon's OS constraint; null when unavailable. */
  totalBytes: number | null;
}

export type JobMemoryErrorCode = 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED' | 'WTM_JOB_MEMORY_BUDGET_EXCEEDED';

export function memoryEstimateError(estimate: number | null | undefined, memory: JobMemoryAdmission): JobMemoryErrorCode | null {
  if (!validBytes(estimate) || estimate === 0) return 'WTM_JOB_MEMORY_ESTIMATE_REQUIRED';
  return estimate > memoryCapacity(memory) ? 'WTM_JOB_MEMORY_BUDGET_EXCEEDED' : null;
}

export function memoryCapacity(memory: JobMemoryAdmission): number {
  if (!validBytes(memory.budgetBytes) || !validBytes(memory.reserveBytes)) return 0;
  return Math.min(memory.budgetBytes, validBytes(memory.totalBytes)
    ? Math.max(0, memory.totalBytes - memory.reserveBytes) : memory.budgetBytes);
}

/** Full held estimates reserve future growth as well as the current available-memory sample. */
export function memoryAllowsClaim(
  estimate: number | null | undefined,
  heldEstimates: readonly (number | null | undefined)[],
  memory: JobMemoryAdmission,
): boolean {
  if (memoryEstimateError(estimate, memory) !== null || !validBytes(memory.availableBytes)
    || heldEstimates.some((held) => !validBytes(held) || held === 0)) return false;
  const held = heldEstimates.reduce<number>((sum, value) => sum + value!, 0);
  if (!Number.isSafeInteger(held)) return false;
  const capacity = Math.min(memoryCapacity(memory), Math.max(0, memory.availableBytes - memory.reserveBytes));
  return estimate! <= capacity - held;
}

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
