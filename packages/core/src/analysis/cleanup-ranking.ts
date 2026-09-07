import type { WorktreeAnalysis } from './worktree-analysis';

/**
 * One worktree offered to the ranking, with whatever else is known about it.
 *
 * Everything but `analysis` is optional, and optional here means genuinely optional: `wtm
 * analyze` answers for repositories WTM has never registered — the workspace root is found by
 * walking up, not by requiring a registration — so a candidate with no {@link
 * ../state/store.WorktreeRecord} is a supported case, not a caller mistake.
 */
export interface CleanupCandidateInput {
  analysis: WorktreeAnalysis;
  /** When WTM last ran something here. Undefined when nothing on record says. */
  lastRuntimeAt?: string | undefined;
  /** When this worktree's HEAD was last committed. Undefined when Git could not answer. */
  lastCommitAt?: string | undefined;
  /**
   * Whether a managed process is live in this worktree. Undefined — no store to ask — is not
   * the same answer as false, and does not rank like it.
   */
  hasRunningProcess?: boolean | undefined;
}

export interface RankedCleanupCandidate extends CleanupCandidateInput {
  /** 1-based position in the returned order. */
  rank: number;
  /** 0-100, derived from the same tiers the order compares. Never the thing sorted on. */
  score: number;
  /** One fact per ranking input, in tier order. An input nothing could answer says so. */
  reason: string[];
}

export interface CleanupRankingOptions {
  /** The instant idleness is measured against. Defaults to now. */
  now?: string | undefined;
}

/**
 * The tier values a candidate is compared on, strongest signal first.
 *
 * Every field is a small non-negative integer where lower is a better cleanup candidate, and the
 * comparison is lexicographic across them in declaration order — never a weighted sum. A weight
 * is a tradeoff assertion nobody can defend (is "merged" worth thirty points or forty, and is
 * that more or less than "idle for two weeks"?), and a total cannot say which fact moved a
 * candidate above another, which is exactly what {@link RankedCleanupCandidate.reason} is for.
 */
interface CleanupTiers {
  /** SAFE, then REVIEW, then BLOCKED. */
  readiness: number;
  /** Provably nothing running, then unknown, then a live process. */
  running: number;
  /** How many of "merged" and "remote-persisted" are *not* provably true. */
  unsettledWork: number;
  /**
   * Persistence confirmed by a fetch, then from local refs only, then absent or unknown.
   *
   * This also decides between the two candidates that satisfy one of the pair each: pushed
   * work outranks merged-but-unpushed work, because a push survives the worktree going away
   * whether or not anything merged it.
   */
  persistence: number;
  /** Days since the last WTM runtime activity, bucketed, longest first. */
  runtimeIdleness: number;
  /** Days since the last commit, bucketed, longest first. */
  commitIdleness: number;
  /** A worktree Git already reports as gone, before one that is still there. */
  present: number;
}

/**
 * The idleness boundaries, in days, longest first. A candidate falls in the first bucket whose
 * threshold it has passed, so bucket 0 is the most idle.
 *
 * The sort compares exact timestamps; these buckets exist only so the score stays a bounded
 * integer. Bucketing is monotone, so it can make two candidates score alike but can never score
 * a less idle one above a more idle one.
 */
const idlenessThresholdDays = [30, 14, 7, 1] as const;

const millisecondsPerDay = 86_400_000;

/**
 * The tiers in comparison order, paired with how many values each one takes.
 *
 * The counts are the radices of a mixed-radix number whose digits are the tier values, which is
 * what makes {@link RankedCleanupCandidate.score} a rendering of the order rather than a second
 * opinion about it: reading the digits most-significant-first *is* the lexicographic comparison.
 */
const tierRadices: ReadonlyArray<readonly [keyof CleanupTiers, number]> = [
  ['readiness', 3],
  ['running', 3],
  ['unsettledWork', 3],
  ['persistence', 3],
  ['runtimeIdleness', idlenessBucketCount()],
  ['commitIdleness', idlenessBucketCount()],
  ['present', 2],
];

/**
 * Orders cleanup candidates best-first, and says why each one landed where it did.
 *
 * Ranking never deletes and never hides: a BLOCKED candidate comes back last, carrying its
 * blockers, because dropping it would be a policy decision disguised as a sort and would hide
 * the one thing a user needs to see to fix it.
 */
export function rankCleanupCandidates(
  candidates: readonly CleanupCandidateInput[],
  options: CleanupRankingOptions = {},
): RankedCleanupCandidate[] {
  const now = Date.parse(options.now ?? new Date().toISOString());
  const measured = candidates.map((candidate) => ({
    candidate,
    tiers: tiersOf(candidate, now),
    idleness: idlenessOf(candidate, now),
  }));
  measured.sort((left, right) => {
    for (const [tier] of tierRadices) {
      const difference = left.tiers[tier] - right.tiers[tier];
      if (difference !== 0) return difference;
    }
    // Exact idleness, so two candidates in the same bucket still order by how idle they are.
    const runtime = right.idleness.runtimeMs - left.idleness.runtimeMs;
    if (runtime !== 0) return runtime;
    const commit = right.idleness.commitMs - left.idleness.commitMs;
    if (commit !== 0) return commit;
    return codeUnitCompare(left.candidate.analysis.identity.path, right.candidate.analysis.identity.path);
  });
  return measured.map(({ candidate, tiers }, index) => ({
    ...candidate,
    rank: index + 1,
    score: scoreOf(tiers),
    reason: reasonsOf(candidate, now),
  }));
}

/**
 * 0-100, computed from the tier values alone.
 *
 * The digits are read as a mixed-radix number and inverted, so a candidate can never score above
 * one that outranks it. Equal scores are possible — the sort breaks ties the score cannot see —
 * but a disagreement is not.
 */
function scoreOf(tiers: CleanupTiers): number {
  let penalty = 0;
  let worst = 0;
  for (const [tier, radix] of tierRadices) {
    penalty = penalty * radix + tiers[tier];
    worst = worst * radix + (radix - 1);
  }
  return worst === 0 ? 100 : Math.round(100 * (1 - penalty / worst));
}

function tiersOf(candidate: CleanupCandidateInput, now: number): CleanupTiers {
  const { safety, base, remotePersistence, remoteKnowledge, identity } = candidate.analysis;
  const merged = base.merged === true;
  const persisted = remotePersistence.persisted;
  const idleness = idlenessOf(candidate, now);
  return {
    readiness: safety.readiness === 'SAFE' ? 0 : safety.readiness === 'REVIEW' ? 1 : 2,
    running: candidate.hasRunningProcess === false ? 0 : candidate.hasRunningProcess === undefined ? 1 : 2,
    unsettledWork: (merged ? 0 : 1) + (persisted ? 0 : 1),
    persistence: !persisted ? 2 : remoteKnowledge.source === 'fetched-refs' ? 0 : 1,
    runtimeIdleness: idlenessBucket(idleness.runtimeMs),
    commitIdleness: idlenessBucket(idleness.commitMs),
    present: isPrunable(identity) ? 0 : 1,
  };
}

/**
 * How long each clock says this worktree has been idle, in milliseconds.
 *
 * An unavailable timestamp measures as zero — the same idleness a worktree active this instant
 * has. That is the whole point: an absent value must not read as "idle and safe", because a list
 * that confidently recommends deleting the worktrees it knows least about is worse than no list.
 */
function idlenessOf(candidate: CleanupCandidateInput, now: number): { runtimeMs: number; commitMs: number } {
  return {
    runtimeMs: elapsedSince(candidate.lastRuntimeAt, now),
    commitMs: elapsedSince(candidate.lastCommitAt, now),
  };
}

function elapsedSince(timestamp: string | undefined, now: number): number {
  if (timestamp === undefined) return 0;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, now - parsed);
}

function idlenessBucket(elapsedMs: number): number {
  const days = elapsedMs / millisecondsPerDay;
  const passed = idlenessThresholdDays.findIndex((threshold) => days >= threshold);
  return passed === -1 ? idlenessThresholdDays.length : passed;
}

function idlenessBucketCount(): number {
  return idlenessThresholdDays.length + 1;
}

function isPrunable(identity: WorktreeAnalysis['identity']): boolean {
  return identity.prunableReason !== null || !identity.pathExists;
}

/**
 * One entry per ranking input, in tier order.
 *
 * Negative facts are kept rather than filtered: they are the answer to "why is this ranked
 * last". An input nothing could answer is named as unknown rather than omitted, so a rank that
 * rests on missing evidence says so.
 */
function reasonsOf(candidate: CleanupCandidateInput, now: number): string[] {
  const { safety, base, remotePersistence, remoteKnowledge, identity } = candidate.analysis;
  const idleness = idlenessOf(candidate, now);
  return [
    safety.readiness,
    candidate.hasRunningProcess === false
      ? 'nothing-running'
      : candidate.hasRunningProcess === undefined ? 'running-unknown' : 'running-process',
    base.merged === null ? 'merged-unknown' : base.merged ? 'merged' : 'not-merged',
    !remotePersistence.persisted
      ? 'not-remote-persisted'
      : remoteKnowledge.source === 'fetched-refs' ? 'remote-persisted' : 'remote-persisted-local-refs-only',
    candidate.lastRuntimeAt === undefined
      ? 'wtm-activity-unknown'
      : elapsedLabel('inactive', idleness.runtimeMs),
    candidate.lastCommitAt === undefined
      ? 'last-commit-unknown'
      : elapsedLabel('last-commit', idleness.commitMs),
    isPrunable(identity) ? 'prunable' : 'not-prunable',
  ];
}

function elapsedLabel(prefix: string, elapsedMs: number): string {
  const days = Math.floor(elapsedMs / millisecondsPerDay);
  return days === 0 ? `${prefix}-today` : `${prefix}-${days}-days`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
