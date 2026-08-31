import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WtmError } from '@wtm/protocol';
import { listGitWorktrees, runGit } from '../git/git-runner';
import {
  analyzeRemotePersistence,
  defaultAllowedRemoteRefs,
  parseNulFormattedRefs,
  type RemotePersistenceAnalysis,
} from './remote-persistence';

export type WorkingTreeClassification = 'clean' | 'staged' | 'unstaged' | 'untracked' | 'unmerged';

export interface WorktreeContext {
  repoPath: string;
  worktreePath: string;
  baseRef?: string;
  allowedRemoteRefs?: readonly string[];
  /**
   * What the caller already did about remote freshness, not an instruction to do anything.
   * {@link analyzeWorktree} never fetches; a caller that wants fresh remote-tracking refs runs
   * {@link refreshRemoteTrackingRefs} itself and passes its result forward here, which is what
   * keeps every network-affecting Git command an explicit choice made outside analysis.
   */
  remoteRefresh?: RemoteRefreshRecord | undefined;
  workspaceId?: string;
  repositoryId?: string;
  worktreeId?: string;
  worktreeNumericId?: number;
}

export interface WorktreeIdentityAnalysis {
  workspaceId?: string;
  repositoryId?: string;
  worktreeId?: string;
  worktreeNumericId?: number;
  path: string;
  isMain: boolean;
  branchRef: string | null;
  detached: boolean;
  headOid: string;
  lockedReason: string | null;
  prunableReason: string | null;
  pathExists: boolean;
  baseRef: string | null;
}

interface WorkingTreeGroups<T> {
  staged: T;
  unstaged: T;
  untracked: T;
  unmerged: T;
  submoduleDirty: T;
}

export interface WorkingTreeAnalysis {
  available: boolean;
  classifications: WorkingTreeClassification[];
  counts: WorkingTreeGroups<number>;
  paths: WorkingTreeGroups<string[]>;
}

export interface UpstreamAnalysis {
  configuredRef: string | null;
  available: boolean;
  ahead: number | null;
  behind: number | null;
}

export interface BaseAnalysis {
  ref: string | null;
  available: boolean;
  ahead: number | null;
  behind: number | null;
  uniqueCommits: number | null;
  headIsAncestor: boolean | null;
  merged: boolean | null;
}

export interface WorktreeSafety {
  readiness: 'SAFE' | 'REVIEW' | 'BLOCKED';
  blockers: WtmError[];
  warnings: WtmError[];
}

/** The completion timestamp of a refresh the caller performed before asking for this analysis. */
export interface RemoteRefreshRecord {
  refreshedAt: string;
}

/**
 * How old the remote-tracking evidence behind {@link RemotePersistenceAnalysis} is.
 *
 * A branch deleted on the remote leaves its remote-tracking ref behind, so local refs alone can
 * report HEAD as remote-persisted long after the remote stopped holding it. A caller that must
 * not delete work on stale evidence checks `confidence` rather than assuming.
 */
export interface RemoteKnowledge {
  source: 'local-refs' | 'fetched-refs';
  refreshed: boolean;
  refreshedAt: string | null;
  confidence: 'LOCAL_ONLY' | 'REFRESHED';
}

export interface WorktreeAnalysis {
  identity: WorktreeIdentityAnalysis;
  workingTree: WorkingTreeAnalysis;
  upstream: UpstreamAnalysis;
  remotePersistence: RemotePersistenceAnalysis;
  remoteKnowledge: RemoteKnowledge;
  base: BaseAnalysis;
  safety: WorktreeSafety;
}

export class WorktreeAnalysisError extends Error {
  readonly code = 'GIT_REPOSITORY_DEGRADED' as const;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = 'WorktreeAnalysisError';
    this.context = context;
  }
}

export async function analyzeWorktree(ctx: WorktreeContext): Promise<WorktreeAnalysis> {
  const topology = await listGitWorktrees(ctx.repoPath);
  const selectedIndex = await findSelectedWorktreeIndex(topology, ctx.worktreePath);
  const selected = topology[selectedIndex];
  if (selected === undefined || selected.bare) {
    throw new WorktreeAnalysisError('Selected path is not a discovered non-bare Git worktree.', {
      repoPath: ctx.repoPath,
      worktreePath: ctx.worktreePath,
    });
  }
  const worktreePath = selected.path;
  const pathExists = await directoryExists(worktreePath);
  const baseRef = ctx.baseRef ?? await resolveDefaultBaseRef(ctx.repoPath, topology);
  const analysisPath = pathExists ? worktreePath : ctx.repoPath;
  const headOid = pathExists
    ? (await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.toString('utf8').trim()
    : selected.head ?? '';
  if (!/^[0-9a-f]{40,64}$/u.test(headOid)) {
    throw new WorktreeAnalysisError('Git returned an invalid HEAD object ID.', { worktreePath });
  }

  const workingTree = pathExists ? await readWorkingTree(worktreePath) : unavailableWorkingTree();
  const upstream = await readUpstream(analysisPath, selected.branch, headOid);
  const remotePersistence = await analyzeRemotePersistence(
    analysisPath,
    headOid,
    ctx.allowedRemoteRefs ?? defaultAllowedRemoteRefs,
  );
  const base = await readBaseAnalysis(analysisPath, baseRef, headOid);
  const identity: WorktreeIdentityAnalysis = {
    ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
    ...(ctx.repositoryId === undefined ? {} : { repositoryId: ctx.repositoryId }),
    ...(ctx.worktreeId === undefined ? {} : { worktreeId: ctx.worktreeId }),
    ...(ctx.worktreeNumericId === undefined ? {} : { worktreeNumericId: ctx.worktreeNumericId }),
    path: worktreePath,
    isMain: selectedIndex === 0 && topology[0]?.bare === false,
    branchRef: selected.branch,
    detached: selected.detached,
    headOid,
    lockedReason: selected.lockedReason,
    prunableReason: selected.prunableReason,
    pathExists,
    baseRef,
  };
  const safety = buildSafety(identity, workingTree, upstream, remotePersistence, base, selected.head);

  return {
    identity,
    workingTree,
    upstream,
    remotePersistence,
    remoteKnowledge: describeRemoteKnowledge(ctx.remoteRefresh),
    base,
    safety,
  };
}

/**
 * Reports what the caller did, and nothing else. Analysis reads local refs only — the decision to
 * spend a network round trip belongs to whoever invoked it, so there is deliberately no branch
 * here that could reach `git fetch`.
 */
function describeRemoteKnowledge(refresh: RemoteRefreshRecord | undefined): RemoteKnowledge {
  if (refresh === undefined) {
    return { source: 'local-refs', refreshed: false, refreshedAt: null, confidence: 'LOCAL_ONLY' };
  }
  return {
    source: 'fetched-refs',
    refreshed: true,
    refreshedAt: refresh.refreshedAt,
    confidence: 'REFRESHED',
  };
}

async function readWorkingTree(worktreePath: string): Promise<WorkingTreeAnalysis> {
  const result = await runGit(worktreePath, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching',
  ]);
  return await withoutSymbolicLinks(worktreePath, parseStatusPorcelainV2(result.stdout));
}

/**
 * Drops symbolic links from what removal treats as work that would be lost.
 *
 * Ignored and untracked files block removal because they are content Git could not give back —
 * a `.env`, a local database. A symbolic link is not content: removing the worktree removes
 * the link, and whatever it points at is somewhere else and survives. If the target happens to
 * be inside this worktree, the target is listed in its own right, so nothing goes unreported.
 *
 * Without this, WTM blocked itself: a `[resources]` table that links a worktree's `.env` at
 * the main working tree's meant that any worktree a task had ever run in could never be removed.
 */
async function withoutSymbolicLinks(
  worktreePath: string,
  analysis: WorkingTreeAnalysis,
): Promise<WorkingTreeAnalysis> {
  const links = await Promise.all(analysis.paths.untracked.map(async (path) => {
    try {
      return (await lstat(resolve(worktreePath, path))).isSymbolicLink() ? path : null;
    } catch {
      // Gone between `git status` and now: not something a removal could lose either.
      return path;
    }
  }));
  const dropped = new Set(links.filter((path): path is string => path !== null));
  if (dropped.size === 0) return analysis;
  const untracked = analysis.paths.untracked.filter((path) => !dropped.has(path));
  const counts = { ...analysis.counts, untracked: untracked.length };
  return {
    ...analysis,
    classifications: classifyWorkingTree(counts),
    counts,
    paths: { ...analysis.paths, untracked },
  };
}

export function parseStatusPorcelainV2(output: Uint8Array): WorkingTreeAnalysis {
  const paths: WorkingTreeGroups<string[]> = {
    staged: [],
    unstaged: [],
    untracked: [],
    unmerged: [],
    submoduleDirty: [],
  };
  const decoded = new TextDecoder().decode(output);
  if (decoded.length > 0 && !decoded.endsWith('\0')) {
    throw malformedStatus('missing-terminal-nul', 0, null);
  }
  const fields = decoded.split('\0');

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (field.length === 0) continue;
    if (field.startsWith('# ')) {
      if (field.length === 2) throw malformedStatus('missing-fields', index, '#');
      continue;
    }
    if (field.startsWith('? ') || field.startsWith('! ')) {
      if (field.length === 2) throw malformedStatus('missing-path', index, field[0] ?? null);
      addPath(paths.untracked, field.slice(2));
      continue;
    }
    if (field.startsWith('u ')) {
      const parts = parseFixedStatusRecord(field, 10, index, 'u');
      validateStatusMetadata(parts, index, 'u', [3, 4, 5, 6], [7, 8, 9]);
      addPath(paths.unmerged, parts.at(-1) ?? '');
      continue;
    }
    if (field.startsWith('1 ') || field.startsWith('2 ')) {
      const renamed = field.startsWith('2 ');
      const recordType = renamed ? '2' : '1';
      const parts = parseFixedStatusRecord(field, renamed ? 9 : 8, index, recordType);
      validateStatusMetadata(parts, index, recordType, [3, 4, 5], [6, 7]);
      if (renamed && !/^[RC]\d+$/u.test(parts[8] ?? '')) {
        throw malformedStatus('invalid-rename-score', index, recordType);
      }
      const xy = parts[1] ?? '..';
      const submodule = parts[2] ?? 'N...';
      validateTrackedStatusSemantics(xy, submodule, index, recordType);
      const path = parts.at(-1) ?? '';
      if (xy[0] !== undefined && xy[0] !== '.') addPath(paths.staged, path);
      if (xy[1] !== undefined && xy[1] !== '.') addPath(paths.unstaged, path);
      if (isDirtySubmodule(submodule)) {
        addPath(paths.submoduleDirty, path);
        if (xy[0] === '.' && xy[1] === '.') addPath(paths.unstaged, path);
      }
      if (renamed) {
        const sourcePath = fields[index + 1];
        if (sourcePath === undefined || sourcePath.length === 0) {
          throw malformedStatus('missing-rename-source', index, recordType);
        }
        index += 1;
      }
      continue;
    }
    throw malformedStatus('unknown-record-type', index, field[0] ?? null);
  }

  const pathGroups = [
    paths.staged,
    paths.unstaged,
    paths.untracked,
    paths.unmerged,
    paths.submoduleDirty,
  ];
  for (const values of pathGroups) values.sort((left, right) => left.localeCompare(right));
  const counts = {
    staged: paths.staged.length,
    unstaged: paths.unstaged.length,
    untracked: paths.untracked.length,
    unmerged: paths.unmerged.length,
    submoduleDirty: paths.submoduleDirty.length,
  };
  return { available: true, classifications: classifyWorkingTree(counts), counts, paths };
}

function classifyWorkingTree(counts: WorkingTreeAnalysis['counts']): WorkingTreeClassification[] {
  const classifications: WorkingTreeClassification[] = [];
  if (counts.staged > 0) classifications.push('staged');
  if (counts.unstaged > 0) classifications.push('unstaged');
  if (counts.untracked > 0) classifications.push('untracked');
  if (counts.unmerged > 0) classifications.push('unmerged');
  if (classifications.length === 0) classifications.push('clean');
  return classifications;
}

async function readUpstream(
  worktreePath: string,
  branchRef: string | null,
  headOid: string,
): Promise<UpstreamAnalysis> {
  if (branchRef === null) {
    return { configuredRef: null, available: false, ahead: null, behind: null };
  }
  const result = await runGit(worktreePath, [
    'for-each-ref', '--format=%(upstream)%00', branchRef,
  ]);
  const configuredRef = parseNulFormattedRefs(result.stdout)[0] ?? null;
  if (configuredRef === null || !(await refExists(worktreePath, configuredRef))) {
    return { configuredRef, available: false, ahead: null, behind: null };
  }
  const counts = await readDivergence(worktreePath, configuredRef, headOid);
  return { configuredRef, available: true, ahead: counts.right, behind: counts.left };
}

async function readBaseAnalysis(
  worktreePath: string,
  baseRef: string | null,
  headOid: string,
): Promise<BaseAnalysis> {
  if (baseRef === null) {
    return {
      ref: null,
      available: false,
      ahead: null,
      behind: null,
      uniqueCommits: null,
      headIsAncestor: null,
      merged: null,
    };
  }
  if (!(await refExists(worktreePath, baseRef))) {
    return {
      ref: baseRef,
      available: false,
      ahead: null,
      behind: null,
      uniqueCommits: null,
      headIsAncestor: null,
      merged: null,
    };
  }
  const counts = await readDivergence(worktreePath, baseRef, headOid);
  const ancestor = await runGit(worktreePath, [
    'merge-base', '--is-ancestor', headOid, baseRef,
  ], { acceptedExitCodes: [0, 1] });
  const headIsAncestor = ancestor.exitCode === 0;
  return {
    ref: baseRef,
    available: true,
    ahead: counts.right,
    behind: counts.left,
    uniqueCommits: counts.right,
    headIsAncestor,
    merged: headIsAncestor,
  };
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await runGit(repoPath, ['for-each-ref', '--format=%(refname)%00', ref]);
  return parseNulFormattedRefs(result.stdout).includes(ref);
}

async function readDivergence(
  repoPath: string,
  leftRef: string,
  rightRef: string,
): Promise<{ left: number; right: number }> {
  const result = await runGit(repoPath, [
    'rev-list', '--left-right', '--count', `${leftRef}...${rightRef}`,
  ]);
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(result.stdout.toString('utf8'));
  if (match === null) {
    throw new WorktreeAnalysisError('Git returned invalid divergence counts.', {
      repoPath,
      leftRef,
      rightRef,
    });
  }
  return { left: Number(match[1]), right: Number(match[2]) };
}

function buildSafety(
  identity: WorktreeIdentityAnalysis,
  workingTree: WorkingTreeAnalysis,
  upstream: UpstreamAnalysis,
  remotePersistence: RemotePersistenceAnalysis,
  base: BaseAnalysis,
  topologyHead: string | null,
): WorktreeSafety {
  const blockers: WtmError[] = [];
  const warnings: WtmError[] = [];
  const worktreeContext = {
    worktreePath: identity.path,
    ...(identity.worktreeId === undefined ? {} : { worktreeId: identity.worktreeId }),
    ...(identity.worktreeNumericId === undefined ? {} : { worktreeNumericId: identity.worktreeNumericId }),
    branchRef: identity.branchRef,
    detached: identity.detached,
  };

  if (!identity.pathExists) {
    blockers.push(gitError(
      'GIT_REPOSITORY_DEGRADED',
      'The discovered Git worktree path does not exist.',
      {
        ...worktreeContext,
        pathExists: false,
        prunableReason: identity.prunableReason,
      },
    ));
  }

  if (identity.isMain) {
    blockers.push(gitError(
      'GIT_MAIN_WORKTREE',
      'The main worktree cannot be removed by WTM.',
      worktreeContext,
    ));
  }
  if (identity.lockedReason !== null) {
    blockers.push(gitError(
      'GIT_WORKTREE_LOCKED',
      'The Git worktree is locked.',
      { ...worktreeContext, reason: identity.lockedReason },
    ));
  }
  if (workingTree.counts.unmerged > 0) {
    blockers.push(gitError(
      'GIT_UNMERGED',
      'The worktree contains unresolved paths.',
      pathContext(worktreeContext, workingTree.paths.unmerged),
    ));
  }
  if (workingTree.counts.staged > 0) {
    blockers.push(gitError(
      'GIT_DIRTY_STAGED',
      'The worktree contains staged changes.',
      pathContext(worktreeContext, workingTree.paths.staged),
    ));
  }
  if (workingTree.counts.unstaged > 0) {
    blockers.push(gitError(
      'GIT_DIRTY_UNSTAGED',
      'The worktree contains unstaged tracked or submodule changes.',
      {
        ...pathContext(worktreeContext, workingTree.paths.unstaged),
        submodulePaths: workingTree.paths.submoduleDirty,
      },
    ));
  }
  if (workingTree.counts.untracked > 0) {
    blockers.push(gitError(
      'GIT_UNTRACKED',
      'The worktree contains untracked files.',
      pathContext(worktreeContext, workingTree.paths.untracked),
    ));
  }
  if (!remotePersistence.persisted) {
    blockers.push({
      ...gitError(
        'GIT_HEAD_NOT_REMOTE_PERSISTED',
        'HEAD is not reachable from an allowed remote-tracking ref.',
        {
          ...worktreeContext,
          headOid: identity.headOid,
          allowedRemoteRefs: remotePersistence.allowedRemoteRefs,
        },
      ),
      remediation: [{
        kind: 'command-suggestion',
        argv: ['git', '-C', identity.path, 'push', '-u', 'origin', 'HEAD'],
      }],
    });
  }
  if (identity.pathExists && (topologyHead === null || topologyHead !== identity.headOid)) {
    blockers.push(gitError(
      'GIT_REPOSITORY_DEGRADED',
      'Git worktree topology and live HEAD are inconsistent.',
      { ...worktreeContext, topologyHead, liveHead: identity.headOid },
    ));
  }
  if (!base.available) {
    warnings.push({
      code: 'GIT_REPOSITORY_DEGRADED',
      message: base.ref === null
        ? 'The repository default/base ref could not be resolved.'
        : 'The configured base ref is unavailable locally.',
      severity: 'warning',
      context: { ...worktreeContext, baseRef: base.ref },
    });
  }
  if (!upstream.available) {
    warnings.push({
      code: 'GIT_UPSTREAM_MISSING',
      message: upstream.configuredRef === null
        ? 'No upstream is configured for this HEAD.'
        : 'The configured upstream ref is unavailable locally.',
      severity: 'warning',
      context: { ...worktreeContext, configuredRef: upstream.configuredRef },
    });
  }

  return {
    readiness: blockers.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'REVIEW' : 'SAFE',
    blockers,
    warnings,
  };
}

function gitError(
  code: WtmError['code'],
  message: string,
  context: Record<string, unknown>,
): WtmError {
  return { code, message, severity: 'error', context };
}

function pathContext(
  base: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  return { ...base, count: paths.length, paths: [...paths] };
}

function parseFixedStatusRecord(
  value: string,
  separators: number,
  recordIndex: number,
  recordType: string,
): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let count = 0; count < separators; count += 1) {
    const separator = value.indexOf(' ', start);
    if (separator === -1) throw malformedStatus('missing-fields', recordIndex, recordType);
    fields.push(value.slice(start, separator));
    start = separator + 1;
  }
  fields.push(value.slice(start));
  if (fields.at(-1)?.length === 0) throw malformedStatus('missing-path', recordIndex, recordType);
  return fields;
}

function validateStatusMetadata(
  fields: readonly string[],
  recordIndex: number,
  recordType: string,
  modeIndexes: readonly number[],
  oidIndexes: readonly number[],
): void {
  if (!/^[.MADRCUT]{2}$/u.test(fields[1] ?? '')) {
    throw malformedStatus('invalid-xy', recordIndex, recordType);
  }
  if (!/^(?:N\.\.\.|S[.C][.M][.U])$/u.test(fields[2] ?? '')) {
    throw malformedStatus('invalid-submodule', recordIndex, recordType);
  }
  if (modeIndexes.some((index) => !/^[0-7]{6}$/u.test(fields[index] ?? ''))) {
    throw malformedStatus('invalid-mode', recordIndex, recordType);
  }
  if (oidIndexes.some((index) => !/^[0-9a-f]{40,64}$/u.test(fields[index] ?? ''))) {
    throw malformedStatus('invalid-object-id', recordIndex, recordType);
  }
}

function validateTrackedStatusSemantics(
  xy: string,
  submodule: string,
  recordIndex: number,
  recordType: '1' | '2',
): void {
  const indexState = xy[0] ?? '';
  const worktreeState = xy[1] ?? '';
  const valid = recordType === '1'
    ? /^[.MTAD]$/u.test(indexState) && /^[.MTAD]$/u.test(worktreeState)
    : /^[RC]$/u.test(indexState) && /^[.MTD]$/u.test(worktreeState);
  const hasChange = xy !== '..' || isDirtySubmodule(submodule);
  if (!valid || !hasChange) {
    throw malformedStatus('invalid-xy-semantics', recordIndex, recordType);
  }
}

function malformedStatus(
  reason: string,
  recordIndex: number,
  recordType: string | null,
): WorktreeAnalysisError {
  return new WorktreeAnalysisError('Git returned malformed porcelain-v2 status output.', {
    reason,
    recordIndex,
    recordType,
  });
}

function addPath(paths: string[], path: string): void {
  if (path.length > 0 && !paths.includes(path)) paths.push(path);
}

function isDirtySubmodule(field: string): boolean {
  return field.startsWith('S') && [...field.slice(1)].some((flag) => flag !== '.');
}

async function findSelectedWorktreeIndex(
  topology: readonly { path: string }[],
  requestedPath: string,
): Promise<number> {
  const lexicalPath = resolve(requestedPath);
  let index = topology.findIndex((record) => record.path === requestedPath || record.path === lexicalPath);
  if (index !== -1) return index;
  try {
    const canonicalPath = await realpath(requestedPath);
    index = topology.findIndex((record) => record.path === canonicalPath);
    return index;
  } catch {
    return -1;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function unavailableWorkingTree(): WorkingTreeAnalysis {
  return {
    available: false,
    classifications: [],
    counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, submoduleDirty: 0 },
    paths: { staged: [], unstaged: [], untracked: [], unmerged: [], submoduleDirty: [] },
  };
}

async function resolveDefaultBaseRef(
  repoPath: string,
  topology: readonly { bare: boolean; branch: string | null }[],
): Promise<string | null> {
  const remoteRefs = await runGit(repoPath, [
    'for-each-ref', '--format=%(refname) %(symref)%00', 'refs/remotes',
  ]);
  const remoteHead = parseNulFormattedRefs(remoteRefs.stdout)
    .map((field) => {
      const separator = field.indexOf(' ');
      return separator === -1
        ? { ref: field, target: '' }
        : { ref: field.slice(0, separator), target: field.slice(separator + 1) };
    })
    .filter(({ ref, target }) => ref.endsWith('/HEAD') && target.startsWith('refs/remotes/'))
    .map(({ target }) => target)
    .sort((left, right) => left.localeCompare(right))[0];
  if (remoteHead !== undefined) return remoteHead;

  const first = topology[0];
  if (first !== undefined && !first.bare && first.branch !== null) return first.branch;
  if (first?.bare === true) {
    const symbolicHead = await runGit(repoPath, ['symbolic-ref', '-q', 'HEAD'], {
      acceptedExitCodes: [0, 1],
    });
    const value = symbolicHead.stdout.toString('utf8').trim();
    if (symbolicHead.exitCode === 0 && value.startsWith('refs/heads/')) return value;
  }
  return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
