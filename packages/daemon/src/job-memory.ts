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
  let physical: number | null = null;
  let constrained: number | null = null;
  try { availableBytes = bytes(readers.available()); } catch { /* unavailable is not zero */ }
  // Read separately: `constrained()` (cgroup/container limits) is the newer, less portable of
  // the two, and a host where it throws is still a host `total()` answered for just fine. A
  // shared try/catch here used to lose that valid physical reading too, leaving `totalBytes`
  // null and the budget check in `@wtm/core`'s own `memoryCapacity` uncapped by physical memory
  // at all on exactly the hosts most likely to need the cap.
  try { physical = bytes(readers.total()); } catch { /* unknown total cannot prove a request unfit for the host */ }
  try { constrained = bytes(readers.constrained()); } catch { /* no constraint is not zero */ }
  const totalBytes = physical !== null && physical > 0
    ? (constrained !== null && constrained > 0 ? Math.min(physical, constrained) : physical)
    : null;
  return { availableBytes, totalBytes };
}

export function sanitizeHostJobMemory(value: HostJobMemory): HostJobMemory {
  return { availableBytes: bytes(value.availableBytes), totalBytes: bytes(value.totalBytes) };
}

function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
