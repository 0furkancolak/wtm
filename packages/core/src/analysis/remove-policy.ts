import type { WtmError } from '@wtm/protocol';
import type { WorktreeAnalysis } from './worktree-analysis';

export class WorktreeRemovalBlockedError extends Error {
  readonly code = 'WTM_REMOVE_BLOCKED' as const;
  readonly blockers: readonly WtmError[];

  constructor(blockers: readonly WtmError[]) {
    super('Worktree removal is blocked by Git safety policy.');
    this.name = 'WorktreeRemovalBlockedError';
    this.blockers = Object.freeze([...blockers]);
  }
}

export function assertRemovable(analysis: WorktreeAnalysis): void {
  if (analysis.safety.blockers.length > 0) {
    throw new WorktreeRemovalBlockedError(analysis.safety.blockers);
  }
}
