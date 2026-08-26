import { describe, expect, test } from 'bun:test';
import type { WorktreeAnalysis } from '../worktree-analysis';
import { assertRemovable, WorktreeRemovalBlockedError } from '../remove-policy';

describe('assertRemovable', () => {
  test('returns without mutation or options when analysis has no blockers', () => {
    const analysis = analysisWithBlockers([]);

    expect(assertRemovable(analysis)).toBeUndefined();
    expect(analysis.safety.blockers).toEqual([]);
  });

  test('throws all original blocker codes and contexts with no force-bypass API', () => {
    const blockers: WorktreeAnalysis['safety']['blockers'] = [{
      code: 'GIT_UNTRACKED',
      message: 'Untracked files would be lost.',
      severity: 'error',
      context: { worktreePath: '/tmp/linked', count: 1, paths: ['keep.txt'] },
    }, {
      code: 'GIT_HEAD_NOT_REMOTE_PERSISTED',
      message: 'HEAD is not reachable from an allowed remote-tracking ref.',
      severity: 'error',
      context: { worktreePath: '/tmp/linked', headOid: 'abc123' },
    }];

    expect(() => assertRemovable(analysisWithBlockers(blockers))).toThrow(WorktreeRemovalBlockedError);
    try {
      assertRemovable(analysisWithBlockers(blockers));
    } catch (error) {
      expect(error).toMatchObject({
        name: 'WorktreeRemovalBlockedError',
        code: 'WTM_REMOVE_BLOCKED',
        blockers,
      });
    }
    expect(assertRemovable.length).toBe(1);
  });
});

function analysisWithBlockers(
  blockers: WorktreeAnalysis['safety']['blockers'],
): WorktreeAnalysis {
  return {
    identity: {
      path: '/tmp/linked',
      isMain: false,
      branchRef: 'refs/heads/feature',
      detached: false,
      headOid: 'abc123',
      lockedReason: null,
      prunableReason: null,
      pathExists: true,
      baseRef: 'refs/heads/main',
    },
    workingTree: {
      available: true,
      classifications: ['clean'],
      counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, submoduleDirty: 0 },
      paths: { staged: [], unstaged: [], untracked: [], unmerged: [], submoduleDirty: [] },
    },
    upstream: { configuredRef: null, available: false, ahead: null, behind: null },
    remotePersistence: {
      allowedRemoteRefs: ['refs/remotes/origin/*'],
      matchingRefs: [],
      containingRefs: [],
      persisted: blockers.length === 0,
    },
    base: {
      ref: 'refs/heads/main',
      available: true,
      ahead: 0,
      behind: 0,
      uniqueCommits: 0,
      headIsAncestor: true,
      merged: true,
    },
    safety: {
      readiness: blockers.length === 0 ? 'SAFE' : 'BLOCKED',
      blockers,
      warnings: [],
    },
  };
}
