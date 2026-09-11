import { totalmem } from 'node:os';

export interface HostJobMemory {
  availableBytes: number | null;
  totalBytes: number | null;
}

/** Node/libuv accounts for the daemon's OS constraints; no process-tree/RSS polling. */
export function readHostJobMemory(readers: {
  available(): number; total(): number; constrained(): number;
} = { available: () => process.availableMemory(), total: totalmem, constrained: () => process.constrainedMemory() }): HostJobMemory {
  let availableBytes: number | null = null;
  let totalBytes: number | null = null;
  try { availableBytes = bytes(readers.available()); } catch { /* unavailable is not zero */ }
  try {
    const physical = bytes(readers.total());
    const constrained = bytes(readers.constrained());
    if (physical !== null && physical > 0) totalBytes = constrained !== null && constrained > 0 ? Math.min(physical, constrained) : physical;
  } catch { /* unknown total cannot prove a request unfit for the host */ }
  return { availableBytes, totalBytes };
}

export function sanitizeHostJobMemory(value: HostJobMemory): HostJobMemory {
  return { availableBytes: bytes(value.availableBytes), totalBytes: bytes(value.totalBytes) };
}

function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
