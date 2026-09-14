import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  containsPath, listGitWorktrees, nameRepositories, resolveFeatureMembers, resolveWorkspaceConfig,
  WtmConfigError,
  type GitWorktreeRecord, type RepositoryRecord, type SQLiteStateStore, type WorkspaceRecord,
} from '@wtm/core';
import type { WtmError } from '@wtm/protocol';

export interface SelectorCandidate {
  repository: { id: string | null; root: string; name: string };
  record: GitWorktreeRecord;
  numericId: number | null;
}

export interface WorktreeMatch { repo: string; branch: string | null; path: string; numericId: number | null }

export type SelectorOutcome =
  | { outcome: 'selected'; candidate: SelectorCandidate }
  | { outcome: 'refused'; error: WtmError };

export type CandidateCollection =
  | { outcome: 'collected'; candidates: SelectorCandidate[]; repositories: string[] }
  | { outcome: 'refused'; error: WtmError };

/**
 * The registered workspace `cwd` belongs to: the one owning the registered worktree `cwd` is in,
 * or else the registered workspace whose root contains it, so this also resolves from a workspace
 * root, which is no repository's worktree.
 */
export function workspaceContaining(store: SQLiteStateStore, cwd: string): WorkspaceRecord | undefined {
  const absolute = resolve(cwd);
  const workspaces = store.listWorkspaces();
  const worktree = store.listWorktrees()
    .filter((candidate) => containsPath(candidate.path, absolute))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (worktree !== undefined) {
    const repository = store.listRepositories().find(({ id }) => id === worktree.repositoryId);
    const owner = workspaces.find(({ id }) => id === repository?.workspaceId);
    if (owner !== undefined) return owner;
  }
  return workspaces
    .filter((candidate) => containsPath(candidate.root, absolute))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

export async function matchWorktreeSelector(input: {
  selector: string; cwd: string; candidates: readonly SelectorCandidate[]; repositories: readonly string[];
  /** The invoked command with `--repo <name>` added, for an ambiguity across repositories. */
  withRepo?: (repo: string) => string[];
}): Promise<SelectorOutcome> {
  const live = input.candidates.filter(({ record }) => !record.bare);
  const current = resolve(input.cwd);
  const base = live.map(({ record }) => record.path)
    .filter((path) => containsPath(path, current))
    .sort((left, right) => right.length - left.length)[0] ?? current;
  const selectorPath = isAbsolute(input.selector) ? input.selector : resolve(base, input.selector);
  const canonical = await realpath(selectorPath).catch(() => null);
  const fullRef = input.selector.startsWith('refs/heads/') ? input.selector : `refs/heads/${input.selector}`;
  const number = /^\d+$/.test(input.selector) ? Number(input.selector) : null;
  const matches = live.filter(({ record, numericId }) =>
    record.path === input.selector
    || record.path === selectorPath
    || (canonical !== null && record.path === canonical)
    || basename(record.path) === input.selector
    || record.branch === input.selector
    || record.branch === fullRef
    || (number !== null && numericId === number));
  if (matches.length === 1) return { outcome: 'selected', candidate: matches[0]! };
  const listed: WorktreeMatch[] = matches
    .map(({ repository, record, numericId }) => ({
      repo: repository.name,
      branch: record.branch === null ? null : record.branch.replace(/^refs\/heads\//, ''),
      path: record.path,
      numericId,
    }))
    .sort((left, right) => compare(left.repo, right.repo) || compare(left.path, right.path));
  const repos = [...new Set(listed.map(({ repo }) => repo))];
  const context = { selector: input.selector, repoPath: base, repositories: [...input.repositories], matches: listed, matchCount: listed.length };
  if (matches.length === 0) {
    return { outcome: 'refused', error: {
      code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error', context,
      message: `No worktree matches ${input.selector}. Name one by branch, by directory name, by number, or by path relative to ${base}.`,
    } };
  }
  return { outcome: 'refused', error: {
    code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error', context,
    message: repos.length > 1
      ? `More than one worktree matches ${input.selector}, in ${repos.join(', ')}. Name the repository with --repo.`
      : `More than one worktree matches ${input.selector}. Name it by path.`,
    ...(repos.length > 1 && input.withRepo !== undefined
      ? { remediation: repos.map((repo) => ({ kind: 'command-suggestion' as const, argv: input.withRepo!(repo) })) }
      : {}),
  } };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function collectSelectorCandidates(input: {
  cwd: string; repo?: string; store: SQLiteStateStore | null; globalConfigPath: string;
}): Promise<CandidateCollection> {
  const workspace = input.store === null ? undefined : workspaceContaining(input.store, input.cwd);
  let names = new Map<string, string>();
  let registered: RepositoryRecord[] = [];
  if (input.store !== null && workspace !== undefined) {
    registered = input.store.listRepositories(workspace.id);
    try {
      const config = await resolveWorkspaceConfig({ workspaceRoot: workspace.root, globalConfigPath: input.globalConfigPath });
      names = nameRepositories({ config: config.value, workspaceRoot: workspace.root, repositories: registered });
      if (input.repo !== undefined) {
        const resolution = resolveFeatureMembers({
          config: config.value, workspaceRoot: workspace.root, repositories: registered, names: [input.repo], option: '--repo',
        });
        if (resolution.outcome === 'refused') return resolution;
        return await fromRepositories(input.store, resolution.repositories, names);
      }
    } catch (error) {
      if (error instanceof WtmConfigError) {
        return { outcome: 'refused', error: { code: error.code, message: error.message, severity: error.severity, context: { ...error.context } } };
      }
      throw error;
    }
  }
  if (input.repo !== undefined) {
    return input.store === null
      ? { outcome: 'refused', error: { code: 'WTM_NOT_INITIALIZED', severity: 'error',
        message: '--repo names a repository of a registered workspace, and no WTM state exists here. Run `wtm init` in the workspace root.' } }
      : { outcome: 'refused', error: { code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error', context: { cwd: input.cwd },
        message: '--repo names a repository of a registered workspace, and this directory is in none.' } };
  }
  const topology = await listGitWorktrees(input.cwd).catch(() => null);
  if (topology !== null && topology.some(({ path }) => containsPath(path, resolve(input.cwd)))) {
    const mainRoot = topology[0]?.path ?? resolve(input.cwd);
    const repository = registered.find((candidate) => candidate.mainRoot === mainRoot)
      ?? input.store?.listRepositories().find((candidate) => candidate.mainRoot === mainRoot) ?? null;
    const name = repository === null ? basename(mainRoot) : names.get(repository.id) ?? basename(mainRoot);
    return {
      outcome: 'collected',
      candidates: withNumbers(input.store, repository, mainRoot, name, topology),
      repositories: [name],
    };
  }
  if (input.store !== null && workspace !== undefined) return await fromRepositories(input.store, registered, names);
  return { outcome: 'refused', error: { code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error', context: { cwd: input.cwd },
    message: `${input.cwd} is inside no Git worktree and no registered workspace.` } };
}

async function fromRepositories(store: SQLiteStateStore, repositories: readonly RepositoryRecord[], names: Map<string, string>): Promise<CandidateCollection> {
  const candidates: SelectorCandidate[] = [];
  for (const repository of repositories) {
    const topology = await listGitWorktrees(repository.mainRoot).catch(() => []);
    candidates.push(...withNumbers(store, repository, repository.mainRoot, names.get(repository.id) ?? basename(repository.mainRoot), topology));
  }
  const listed = [...new Set(repositories.map((repository) => names.get(repository.id) ?? basename(repository.mainRoot)))].sort(compare);
  return { outcome: 'collected', candidates, repositories: listed };
}

function withNumbers(
  store: SQLiteStateStore | null, repository: RepositoryRecord | null, mainRoot: string, name: string, topology: readonly GitWorktreeRecord[],
): SelectorCandidate[] {
  const numbers = new Map((repository === null || store === null ? [] : store.listWorktrees(repository.id)).map(({ path, numericId }) => [path, numericId]));
  return topology.map((record) => ({
    repository: { id: repository?.id ?? null, root: mainRoot, name },
    record,
    numericId: numbers.get(record.path) ?? null,
  }));
}
