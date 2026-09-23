import type { ManagedProcessRecord } from '@wtm/core';
import type { WtmError } from '@wtm/protocol';
import { readHostJobMemory, type HostJobMemory } from './job-memory';

/** `[budgets]` admission limits (todo item 19), already resolved to raw bytes/counts. */
export interface ProcessBudgets {
  maxProcesses?: number;
  minAvailableMemoryBytes?: number;
}

/**
 * The two-limit `[budgets]` admission check (docs/07's "Resource budgets": "a daemon-wide,
 * host-scoped admission gate on `start`/`restart`"). Shared by `DaemonRuntimeController` (a
 * person's `start`/`restart`) and `LifecycleEventDispatcher` (`[events."<name>"].tasks`, the
 * daemon's own automation) so the two spawn paths cannot silently disagree about whether a limit
 * applies -- extracted after a round-25 audit finding that the dispatcher called the supervisor
 * directly, so an event-triggered start was never checked against either limit at all, letting a
 * `[dev-overlay.repos...]`-style burst of `worktree.created`/`worktree.discovered` events (e.g.
 * from `wtm init`-ing several branches at once) blow straight past `max_processes` and
 * `min_available_memory_mib`.
 *
 * `pendingStarts` folds in admissions a caller's own in-flight-reservation counter already
 * tracked but that `supervisor.list()` cannot see yet, because `start()`/`restart()` is itself
 * async (see `DaemonRuntimeController`'s own `#pendingStarts` field for why one is needed at
 * all). Passing `0` is correct for a caller with no such counter of its own, at the cost of
 * leaving the same narrow TOCTOU race that counter exists to close, only between that caller and
 * any other concurrent caller of this function -- accepted here because the alternative (a
 * counter shared across `DaemonRuntimeController` and `LifecycleEventDispatcher`) needs the two
 * to be constructed in a fixed order or given a third shared object, and the gap this closes (no
 * check at all) is by far the larger one.
 */
export function checkProcessBudgets(input: {
  supervisor: { list(worktreeId?: string): ManagedProcessRecord[] };
  budgets: ProcessBudgets;
  readMemory: () => HostJobMemory;
  pendingStarts: number;
  worktreeId: string;
  taskName: string;
}): WtmError | null {
  const { maxProcesses, minAvailableMemoryBytes } = input.budgets;
  if (maxProcesses !== undefined) {
    const current = input.supervisor.list()
      .filter((record) => ['STARTING', 'RUNNING', 'STOPPING'].includes(record.state)).length
      + input.pendingStarts;
    if (current >= maxProcesses) {
      return {
        code: 'RUNTIME_PROCESS_BUDGET_EXCEEDED',
        message: 'Starting this task would exceed the configured process budget.',
        severity: 'error',
        context: { taskName: input.taskName, worktreeId: input.worktreeId, limit: maxProcesses, current },
      };
    }
  }
  if (minAvailableMemoryBytes !== undefined) {
    const { availableBytes } = input.readMemory();
    if (availableBytes !== null && availableBytes < minAvailableMemoryBytes) {
      return {
        code: 'RUNTIME_MEMORY_BUDGET_EXCEEDED',
        message: 'Starting this task would drop host available memory below the configured floor.',
        severity: 'error',
        context: {
          taskName: input.taskName, worktreeId: input.worktreeId,
          floorMib: Math.floor(minAvailableMemoryBytes / (1024 * 1024)),
          availableMib: Math.floor(availableBytes / (1024 * 1024)),
        },
      };
    }
  }
  return null;
}

export { readHostJobMemory, type HostJobMemory };
