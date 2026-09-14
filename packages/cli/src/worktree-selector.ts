import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  containsPath, listGitWorktrees, nameRepositories, resolveFeatureMembers, resolveWorkspaceConfig,
  SQLiteStateStore, WtmConfigError,
  type GitWorktreeRecord, type RepositoryRecord, type WorkspaceRecord,
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

export type TaskTarget =
  | { outcome: 'resolved'; cwd: string }
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
  // An empty or whitespace-only selector names nothing — treating it as a no-match refusal keeps
  // it from resolving relative to `base` the way `resolve(base, '')` would (to `base` itself).
  const matches = input.selector.trim() === '' ? [] : live.filter(({ record, numericId }) =>
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
      candidates: await withNumbers(input.store, repository, mainRoot, name, topology),
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
    candidates.push(...await withNumbers(store, repository, repository.mainRoot, names.get(repository.id) ?? basename(repository.mainRoot), topology));
  }
  const listed = [...new Set(repositories.map((repository) => names.get(repository.id) ?? basename(repository.mainRoot)))].sort(compare);
  return { outcome: 'collected', candidates, repositories: listed };
}

/**
 * Registered worktrees are keyed by number against Git topology after `realpath`, the way
 * `remove` compared them at ba36763: a stored path can be a symlinked spelling of the same
 * worktree Git itself reports canonically, and the two must still be recognized as one worktree.
 * `realpath` failing (the path no longer exists) falls back to comparing the raw path.
 */
async function withNumbers(
  store: SQLiteStateStore | null, repository: RepositoryRecord | null, mainRoot: string, name: string, topology: readonly GitWorktreeRecord[],
): Promise<SelectorCandidate[]> {
  const registered = repository === null || store === null ? [] : store.listWorktrees(repository.id);
  const numbers = new Map(await Promise.all(registered.map(async ({ path, numericId }) =>
    [await realpath(path).catch(() => path), numericId] as const)));
  return await Promise.all(topology.map(async (record) => ({
    repository: { id: repository?.id ?? null, root: mainRoot, name },
    record,
    numericId: numbers.get(await realpath(record.path).catch(() => record.path)) ?? null,
  })));
}

/**
 * Where the seven task commands (`resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`)
 * send their request: `input.cwd` unchanged without `--worktree`, or the selected worktree's
 * root, or a refusal — `--repo` without `--worktree` (design §1), an unresolved or ambiguous
 * selector (`matchWorktreeSelector`), or a workspace root named with neither flag (design §4).
 */
export async function resolveTaskTarget(input: {
  cwd: string;
  /** The invoked command as typed, without the target flags: `['wtm', 'start', 'dev']`. */
  argv: readonly string[];
  worktree?: string;
  repo?: string;
  databasePath: string;
  globalConfigPath: string;
}): Promise<TaskTarget> {
  if (input.repo !== undefined && input.worktree === undefined) {
    return { outcome: 'refused', error: {
      code: 'WTM_CONFIG_INVALID',
      severity: 'error',
      message: '--repo names the repository of --worktree; give --worktree as well.',
      context: { repo: input.repo },
    } };
  }
  if (input.worktree !== undefined) {
    const store = openReadonlyStore(input.databasePath);
    try {
      const collected = await collectSelectorCandidates({
        cwd: input.cwd, store, globalConfigPath: input.globalConfigPath,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
      });
      if (collected.outcome === 'refused') return collected;
      const worktree = input.worktree;
      const matched = await matchWorktreeSelector({
        selector: worktree,
        cwd: input.cwd,
        candidates: collected.candidates,
        repositories: collected.repositories,
        withRepo: (repo) => [...input.argv, '--worktree', worktree, '--repo', repo],
      });
      return matched.outcome === 'refused' ? matched : { outcome: 'resolved', cwd: matched.candidate.record.path };
    } finally {
      store?.close();
    }
  }
  // Without --worktree, every command keeps sending exactly the request it sends today, unless
  // cwd is a registered workspace root — no repository's worktree — which only the daemon-backed
  // commands used to reach through a misleading message (design §4). This probe must never make a
  // flag-less command worse off than it was before item 47: a store that cannot even run a query
  // (a stale schema, SQLITE_BUSY, ...) falls back to sending `cwd` unchanged, the same as no state
  // existing at all. Only a probe that *succeeds* may refuse with the §4 message.
  try {
    // A short busy timeout, not the store's usual one: this probe already has a safe fallback for
    // a store failure, so waiting out a lock before taking it would only turn "unchanged today"
    // into "stalls today" for no benefit. `SQLiteStateStore` otherwise waits up to 5s even for a
    // readonly open (see `sqlite-store.ts`), which is fine for a resolution the caller actually
    // needs to succeed, but not for a probe that is thrown away on any store error.
    const store = openReadonlyStore(input.databasePath, { busyTimeoutMs: 0 });
    if (store === null) return { outcome: 'resolved', cwd: input.cwd };
    try {
      const workspace = workspaceContaining(store, input.cwd);
      const current = resolve(input.cwd);
      if (workspace === undefined || store.listWorktrees().some(({ path }) => containsPath(path, current))) {
        return { outcome: 'resolved', cwd: input.cwd };
      }
      // Git failing here — most commonly a workspace root that is itself no repository, exactly
      // the case §4 exists for — means "not inside a worktree", not "give up": that conclusion is
      // what lets the refusal below fire for a multi-repository workspace root. Only the *store*
      // queries above and below fall back to resolving `cwd` unchanged on failure.
      const insideGitWorktree = await listGitWorktrees(input.cwd)
        .then((topology) => topology.some(({ path }) => containsPath(path, current)), () => false);
      if (insideGitWorktree) return { outcome: 'resolved', cwd: input.cwd };
      const collected = await collectSelectorCandidates({ cwd: input.cwd, store, globalConfigPath: input.globalConfigPath });
      const candidates: WorktreeMatch[] = collected.outcome === 'collected'
        ? collected.candidates
          .filter(({ record }) => !record.bare)
          .map(({ repository, record, numericId }) => ({
            repo: repository.name,
            branch: record.branch === null ? null : record.branch.replace(/^refs\/heads\//, ''),
            path: record.path,
            numericId,
          }))
        : [];
      return { outcome: 'refused', error: {
        code: 'WTM_WORKSPACE_NOT_FOUND',
        severity: 'error',
        message: 'This is a workspace root, not a worktree. Name the target with `--worktree <selector>`.',
        context: { cwd: input.cwd, workspace: workspace.name, candidates },
        remediation: [{ kind: 'command-suggestion', argv: [...input.argv, '--worktree', '<selector>'] }],
      } };
    } finally {
      store.close();
    }
  } catch {
    return { outcome: 'resolved', cwd: input.cwd };
  }
}

/** A readonly handle on the state database, or `null` when none exists yet or it cannot be opened. */
function openReadonlyStore(databasePath: string, options: { busyTimeoutMs?: number } = {}): SQLiteStateStore | null {
  if (!existsSync(databasePath)) return null;
  try {
    return new SQLiteStateStore(databasePath, { readonly: true, ...options });
  } catch {
    return null;
  }
}
