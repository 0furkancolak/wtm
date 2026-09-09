import { describe, expect, test } from 'bun:test';
import { rankCleanupCandidates, type CleanupCandidateInput } from '../cleanup-ranking';
import type { WorktreeAnalysis } from '../worktree-analysis';

const now = '2026-09-07T00:00:00.000Z';

function daysAgo(days: number): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

function analysis(overrides: {
  path?: string;
  readiness?: WorktreeAnalysis['safety']['readiness'];
  merged?: boolean | null;
  persisted?: boolean;
  source?: WorktreeAnalysis['remoteKnowledge']['source'];
  prunableReason?: string | null;
  pathExists?: boolean;
} = {}): WorktreeAnalysis {
  return {
    identity: {
      path: overrides.path ?? '/repo/wt',
      isMain: false,
      branchRef: 'refs/heads/feature',
      detached: false,
      headOid: 'a'.repeat(40),
      lockedReason: null,
      prunableReason: overrides.prunableReason ?? null,
      pathExists: overrides.pathExists ?? true,
      baseRef: 'refs/heads/main',
    },
    workingTree: {
      available: true,
      classifications: ['clean'],
      counts: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, unmerged: 0, submoduleDirty: 0 },
      paths: { staged: [], unstaged: [], untracked: [], ignored: [], unmerged: [], submoduleDirty: [] },
    },
    upstream: { configuredRef: null, available: false, ahead: null, behind: null },
    remotePersistence: {
      allowedRemoteRefs: ['refs/remotes/origin/*'],
      matchingRefs: [],
      containingRefs: [],
      persisted: overrides.persisted ?? false,
    },
    remoteKnowledge: {
      source: overrides.source ?? 'local-refs',
      refreshed: false,
      refreshedAt: null,
      confidence: overrides.source === 'fetched-refs' ? 'REFRESHED' : 'LOCAL_ONLY',
    },
    base: {
      ref: 'refs/heads/main',
      available: true,
      ahead: 0,
      behind: 0,
      uniqueCommits: 0,
      headIsAncestor: overrides.merged ?? null,
      merged: overrides.merged ?? null,
    },
    safety: { readiness: overrides.readiness ?? 'SAFE', blockers: [], warnings: [] },
  };
}

/** A candidate that knows everything, so a test can vary one input at a time. */
function candidate(
  path: string,
  overrides: Partial<CleanupCandidateInput> & Parameters<typeof analysis>[0] = {},
): CleanupCandidateInput {
  const { lastRuntimeAt, lastCommitAt, hasRunningProcess, ...shape } = overrides;
  return {
    analysis: analysis({ path, ...shape }),
    lastRuntimeAt: 'lastRuntimeAt' in overrides ? lastRuntimeAt : daysAgo(30),
    lastCommitAt: 'lastCommitAt' in overrides ? lastCommitAt : daysAgo(30),
    hasRunningProcess: 'hasRunningProcess' in overrides ? hasRunningProcess : false,
  };
}

function order(candidates: readonly CleanupCandidateInput[]): string[] {
  return rankCleanupCandidates(candidates, { now }).map(({ analysis }) => analysis.identity.path);
}

// Ordering tests name their worktrees so that plain path order is the *reverse* of the
// expected order: a tier that stopped separating two candidates would then fall through to
// the path tie-break and produce the wrong answer, rather than the right one by accident.
describe('rankCleanupCandidates', () => {
  test('ranks SAFE above REVIEW above BLOCKED, and keeps the blocked one in the list', () => {
    const ranked = rankCleanupCandidates([
      candidate('/repo/blocked', { readiness: 'BLOCKED' }),
      candidate('/repo/safe', { readiness: 'SAFE' }),
      candidate('/repo/review', { readiness: 'REVIEW' }),
    ], { now });
    expect(ranked.map(({ analysis }) => analysis.identity.path))
      .toEqual(['/repo/safe', '/repo/review', '/repo/blocked']);
    expect(ranked.map(({ rank }) => rank)).toEqual([1, 2, 3]);
    expect(ranked[2]?.reason).toContain('BLOCKED');
  });

  test('a worktree with a live managed process ranks below an identical one without', () => {
    expect(order([
      candidate('/repo/a', { hasRunningProcess: true }),
      candidate('/repo/b', { hasRunningProcess: false }),
    ])).toEqual(['/repo/b', '/repo/a']);
  });

  test('not knowing whether anything is running ranks between provably idle and provably busy', () => {
    expect(order([
      candidate('/repo/a-running', { hasRunningProcess: true }),
      candidate('/repo/m-unknown', { hasRunningProcess: undefined }),
      candidate('/repo/z-quiet', { hasRunningProcess: false }),
    ])).toEqual(['/repo/z-quiet', '/repo/m-unknown', '/repo/a-running']);
  });

  test('merged and remote-persisted ranks above one of the two, which ranks above neither', () => {
    expect(order([
      candidate('/repo/a-neither', { merged: false, persisted: false }),
      candidate('/repo/z-both', { merged: true, persisted: true }),
      candidate('/repo/m-merged-only', { merged: true, persisted: false }),
    ])).toEqual(['/repo/z-both', '/repo/m-merged-only', '/repo/a-neither']);
  });

  test('persistence known only from local refs ranks below the same candidate after a fetch', () => {
    expect(order([
      candidate('/repo/a-stale', { merged: true, persisted: true, source: 'local-refs' }),
      candidate('/repo/z-fetched', { merged: true, persisted: true, source: 'fetched-refs' }),
    ])).toEqual(['/repo/z-fetched', '/repo/a-stale']);
    expect(rankCleanupCandidates([
      candidate('/repo/a-stale', { merged: true, persisted: true, source: 'local-refs' }),
    ], { now })[0]?.reason).toContain('remote-persisted-local-refs-only');
  });

  test('remote-persisted alone outranks merged alone, because pushed work survives either way', () => {
    expect(order([
      candidate('/repo/a-merged-only', { merged: true, persisted: false }),
      candidate('/repo/z-persisted-only', { merged: false, persisted: true }),
    ])).toEqual(['/repo/z-persisted-only', '/repo/a-merged-only']);
  });

  test('an idle worktree ranks above a recently active one', () => {
    expect(order([
      candidate('/repo/busy', { lastRuntimeAt: daysAgo(0) }),
      candidate('/repo/idle', { lastRuntimeAt: daysAgo(45) }),
    ])).toEqual(['/repo/idle', '/repo/busy']);
  });

  test('no WTM activity on record does not outrank a provably idle worktree', () => {
    expect(order([
      candidate('/repo/a-unrecorded', { lastRuntimeAt: undefined }),
      candidate('/repo/z-idle', { lastRuntimeAt: daysAgo(45) }),
    ])).toEqual(['/repo/z-idle', '/repo/a-unrecorded']);
  });

  test('no commit timestamp does not outrank a worktree whose last commit is old', () => {
    expect(order([
      candidate('/repo/a-unrecorded', { lastCommitAt: undefined }),
      candidate('/repo/z-old', { lastCommitAt: daysAgo(45) }),
    ])).toEqual(['/repo/z-old', '/repo/a-unrecorded']);
  });

  test('a prunable worktree ranks above an otherwise identical present one', () => {
    expect(order([
      candidate('/repo/a-present'),
      candidate('/repo/z-gone', { prunableReason: 'gitdir file points to non-existent location' }),
    ])).toEqual(['/repo/z-gone', '/repo/a-present']);
  });

  test('a worktree whose directory is gone counts as prunable even before Git says so', () => {
    expect(order([
      candidate('/repo/a-present'),
      candidate('/repo/z-missing', { pathExists: false }),
    ])).toEqual(['/repo/z-missing', '/repo/a-present']);
  });

  test('an unknown input never outranks proven idleness, and says which input was unavailable', () => {
    const unregistered = candidate('/repo/a-unregistered', {
      merged: true,
      persisted: true,
      source: 'fetched-refs',
      lastRuntimeAt: undefined,
      lastCommitAt: undefined,
      hasRunningProcess: undefined,
    });
    const known = candidate('/repo/z-known', { merged: true, persisted: true, source: 'fetched-refs' });
    expect(order([unregistered, known])).toEqual(['/repo/z-known', '/repo/a-unregistered']);
    const ranked = rankCleanupCandidates([unregistered], { now })[0];
    expect(ranked?.reason).toContain('running-unknown');
    expect(ranked?.reason).toContain('wtm-activity-unknown');
    expect(ranked?.reason).toContain('last-commit-unknown');
  });

  test('reason carries one fact per ranking input, in tier order', () => {
    const ranked = rankCleanupCandidates([
      candidate('/repo/wt', { merged: true, persisted: true, source: 'fetched-refs', lastRuntimeAt: daysAgo(14) }),
    ], { now })[0];
    expect(ranked?.reason).toEqual([
      'SAFE',
      'nothing-running',
      'merged',
      'remote-persisted',
      'inactive-14-days',
      'last-commit-30-days',
      'not-prunable',
    ]);
  });

  test('candidates identical on every tier come back in path order', () => {
    expect(order([candidate('/repo/c'), candidate('/repo/a'), candidate('/repo/b')]))
      .toEqual(['/repo/a', '/repo/b', '/repo/c']);
  });

  test('shuffling the input does not change the order', () => {
    const candidates = [
      candidate('/repo/e', { readiness: 'BLOCKED' }),
      candidate('/repo/d', { hasRunningProcess: true }),
      candidate('/repo/c', { merged: true }),
      candidate('/repo/b', { merged: true, persisted: true, source: 'fetched-refs' }),
      candidate('/repo/a', { lastRuntimeAt: undefined }),
    ];
    const first = order(candidates);
    expect(order([...candidates].reverse())).toEqual(first);
    expect(order([candidates[2]!, candidates[4]!, candidates[0]!, candidates[3]!, candidates[1]!]))
      .toEqual(first);
  });

  test('score never disagrees with rank', () => {
    const ranked = rankCleanupCandidates([
      candidate('/repo/e', { readiness: 'BLOCKED' }),
      candidate('/repo/d', { hasRunningProcess: true }),
      candidate('/repo/c', { merged: true }),
      candidate('/repo/b', { merged: true, persisted: true, source: 'fetched-refs' }),
      candidate('/repo/a', { lastRuntimeAt: undefined, lastCommitAt: undefined }),
      candidate('/repo/f', { prunableReason: 'prunable' }),
    ], { now });
    for (const [index, entry] of ranked.entries()) {
      expect(entry.rank).toBe(index + 1);
      const next = ranked[index + 1];
      if (next !== undefined) expect(entry.score).toBeGreaterThanOrEqual(next.score);
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(100);
    }
  });

  test('ranks an empty list without inventing a candidate', () => {
    expect(rankCleanupCandidates([], { now })).toEqual([]);
  });
});
