/** Keeps both output streams, retained archives and mutation evidence within one bounded batch. */
export const maxRetainedLogFiles = 32;

export function retainedLogCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxRetainedLogFiles) {
    throw new RangeError(`Retained log count must be between 1 and ${maxRetainedLogFiles}.`);
  }
  return value;
}
