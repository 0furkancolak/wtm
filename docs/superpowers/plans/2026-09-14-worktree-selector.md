# Worktree Selector for Task Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wtm resolve/run/start/stop/restart/logs/exec --worktree <selector> [--repo <name>]` act on another worktree without `cd`, through one selector shared with `analyze` and `remove`.

**Architecture:** A new CLI module resolves a selector to one worktree root and the six task commands send that root as the `cwd` they already send; the daemon and IPC protocol do not change. `remove` and `analyze` replace their two private resolvers with the same module. Completion scripts gain flag-value branches.

**Tech Stack:** Bun 1.3 test runner, TypeScript (strict, `exactOptionalPropertyTypes`), Commander, `@wtm/core` (Git topology, SQLite state store, config), `@wtm/protocol` envelopes.

**Spec:** `docs/superpowers/specs/2026-09-14-worktree-selector-design.md`

## Global Constraints

- The daemon, `packages/daemon`, and the IPC request shapes do not change. A task command with `--worktree` sends exactly the request it sends today, with `cwd` replaced by the selected worktree root.
- Without `--worktree` and `--repo`, every command behaves exactly as today, except the workspace-root refusal of spec §4.
- No new error codes. Selector failures are `WTM_WORKSPACE_NOT_FOUND`; `--repo` misuse and unknown or ambiguous repository names are `WTM_CONFIG_INVALID`; `--repo` without registered state is `WTM_NOT_INITIALIZED`.
- Remediation items are `{ kind: 'command-suggestion', argv: string[] }` (`packages/protocol/src/errors.ts`).
- `exactOptionalPropertyTypes` is on: spread optional fields (`...(x === undefined ? {} : { x })`), never assign `undefined`.
- `@wtm/core` must not mention `process.platform` or `process.getuid` (structural test).
- `packages/testkit/src/__tests__/scenario-guard.test.ts` forbids synchronous node/bun spawns outside `runScenario`; scenarios run through `runScenario`.
- Tests never touch the real `~/Library` (or XDG) WTM state: every test that can reach a state store passes an explicit database path inside a temporary directory.
- Relative path selectors resolve against the worktree containing `cwd`, or against `cwd` when it is inside no worktree (spec §2 as corrected).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Targeted tests: `bun test --timeout 60000 <files>`. Full gate: `bun run typecheck && bun run lint && bun run test` (about 200 s; never two at once).

## Decisions made while planning

- `wtm resolve` also gets `--worktree`/`--repo`. It answers the question `run` answers, completion already treats it as a task command, and the scenario uses it to observe foreground resolution. Cost if wrong: one extra documented command.
- `ps` does not get the flags (it is not in the item; it lists by worktree the same way `stop` without a task does). Cost if wrong: a follow-up.
- `resolveFeatureMembers` gains an `option` parameter so its refusal names `--repo` or `--repos` correctly, instead of a second name-resolution function.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/analysis/create-feature.ts` (modify) | `nameRepositories` (id → name), `resolveFeatureMembers` `option` parameter |
| `packages/cli/src/worktree-selector.ts` (create) | `workspaceContaining`, `matchWorktreeSelector` (pure), `collectSelectorCandidates` (Git + store), `resolveTaskTarget` (the six commands' entry point) |
| `packages/cli/src/commands/create-feature.ts` (modify) | import `workspaceContaining` from the new module |
| `packages/cli/src/commands/remove.ts` (modify) | use `matchWorktreeSelector`; delete `resolveExplicitSelector`, `canonicalSelectorPath`, `WorktreeSelectorError` |
| `packages/cli/src/main.ts` (modify) | analyze/remove use the shared selector; delete `resolveAnalysisSelector`, `numericSelectorPath`; `--worktree`/`--repo` on seven commands; completion data kinds |
| `packages/cli/src/commands/completion.ts` (modify) | flag-value completion, `repo-names` kind, tasks honouring the flags |
| `packages/cli/src/__tests__/worktree-selector.test.ts` (create) | unit tests |
| `packages/cli/src/__tests__/worktree-selector.scenario.ts` + `.test.ts` (create) | real Git scenario |
| docs, skill, CHANGELOG, todo | Task 7 |

---

### Task 1: Repository names in core

**Files:**
- Modify: `packages/core/src/analysis/create-feature.ts:14-62`
- Modify: `packages/core/src/index.ts:52` (export `nameRepositories`)
- Test: `packages/core/src/analysis/__tests__/create-feature.test.ts`

**Interfaces:**
- Produces: `export function nameRepositories(input: { config: WtmConfig; workspaceRoot: string; repositories: readonly RepositoryRecord[] }): Map<string, string>` — repository id → the name `--repos`/`--repo` accepts (a `[repos.<name>]` entry, else the main root's directory name).
- Produces: `resolveFeatureMembers(input: { config; workspaceRoot; repositories; names; option?: '--repos' | '--repo' })` — unchanged result type; refusal messages use `option` (default `'--repos'`).

- [ ] **Step 1: Write the failing tests** (append to `create-feature.test.ts`, reusing that file's existing config/repository helpers; if it builds `RepositoryRecord`s inline, build these the same way)

```ts
describe('nameRepositories', () => {
  test('names a repository by its [repos] entry, otherwise by its directory', () => {
    const repositories = [repositoryRecord('r1', '/ws/web'), repositoryRecord('r2', '/ws/services/api')];
    const config = { repos: { backend: { path: 'services/api' } } } as unknown as WtmConfig;

    const names = nameRepositories({ config, workspaceRoot: '/ws', repositories });

    expect([...names.entries()]).toEqual([['r1', 'web'], ['r2', 'backend']]);
  });
});

test('resolveFeatureMembers names --repo in its refusal when asked to', () => {
  const repositories = [repositoryRecord('r1', '/ws/web')];

  const resolution = resolveFeatureMembers({
    config: {} as WtmConfig, workspaceRoot: '/ws', repositories, names: ['nope'], option: '--repo',
  });

  expect(resolution).toMatchObject({ outcome: 'refused', error: { code: 'WTM_CONFIG_INVALID' } });
  expect(resolution.outcome === 'refused' && resolution.error.message).toBe('--repo names no repository of this workspace: nope.');
});
```

`repositoryRecord(id, mainRoot)` returns `{ id, workspaceId: 'w1', commonGitDir: `${mainRoot}/.git`, mainRoot, remoteIdentity: null, createdAt: '2026-09-14T00:00:00.000Z', lastReconciledAt: null }`; add it to the test file if it has no equivalent.

- [ ] **Step 2: Run to verify failure**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature.test.ts`
Expected: FAIL — `nameRepositories` is not exported; the `--repo` message reads `--repos`.

- [ ] **Step 3: Implement**

In `create-feature.ts`, extract the naming already inside `resolveFeatureMembers`:

```ts
/** The name `--repos` and `--repo` accept for each repository, by id. */
export function nameRepositories(input: {
  config: WtmConfig;
  workspaceRoot: string;
  repositories: readonly RepositoryRecord[];
}): Map<string, string> {
  return new Map(namedRepositories(input).map((entry) => [entry.repository.id, entry.scopeName ?? entry.directory]));
}

function namedRepositories(input: { config: WtmConfig; workspaceRoot: string; repositories: readonly RepositoryRecord[] }) {
  return input.repositories.map((repository) => ({
    repository,
    scopeName: resolveRepoScope(input.config, { workspaceRoot: input.workspaceRoot, repoRoot: repository.mainRoot })?.name ?? null,
    directory: basename(resolve(repository.mainRoot)),
  }));
}
```

Change `resolveFeatureMembers` to take `option?: '--repos' | '--repo'`, compute `const option = input.option ?? '--repos';`, use `namedRepositories(input)` for `named`, and replace the three literal `--repos` strings in `reasons` with `${option}`. Add `nameRepositories` to the existing export line in `packages/core/src/index.ts:52`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test --timeout 60000 packages/core/src/analysis/__tests__/create-feature.test.ts packages/cli/src/__tests__/create-feature.test.ts`
Expected: PASS (the CLI create-feature tests still see `--repos` messages).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analysis/create-feature.ts packages/core/src/index.ts packages/core/src/analysis/__tests__/create-feature.test.ts
git commit -m "feat(core): name repositories for --repo and let the member refusal name its option (item 47)"
```

---

### Task 2: The selector module

**Files:**
- Create: `packages/cli/src/worktree-selector.ts`
- Modify: `packages/cli/src/commands/create-feature.ts:498-512` (delete local `workspaceContaining`, import it)
- Test: `packages/cli/src/__tests__/worktree-selector.test.ts`

**Interfaces:**
- Consumes: `nameRepositories`, `resolveFeatureMembers` (Task 1); `listGitWorktrees`, `containsPath`, `resolveWorkspaceConfig`, `SQLiteStateStore`, `WtmConfigError` from `@wtm/core`.
- Produces (exact):

```ts
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

export function workspaceContaining(store: SQLiteStateStore, cwd: string): WorkspaceRecord | undefined;
export function matchWorktreeSelector(input: {
  selector: string;
  cwd: string;
  candidates: readonly SelectorCandidate[];
  repositories: readonly string[];
  /** The invoked command with `--repo <name>` added, for an ambiguity across repositories. */
  withRepo?: (repo: string) => string[];
}): Promise<SelectorOutcome>;
export function collectSelectorCandidates(input: {
  cwd: string;
  repo?: string;
  store: SQLiteStateStore | null;
  globalConfigPath: string;
}): Promise<CandidateCollection>;
```

- [ ] **Step 1: Write the failing unit tests for `matchWorktreeSelector`**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchWorktreeSelector, type SelectorCandidate } from '../worktree-selector';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-selector-')));
  roots.push(root);
  const paths = {
    webMain: join(root, 'web'), webAuth: join(root, 'web-feat-auth'),
    apiMain: join(root, 'api'), apiAuth: join(root, 'api-feat-auth'), numbered: join(root, '13'),
  };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  const candidate = (repo: string, path: string, branch: string | null, numericId: number | null, bare = false): SelectorCandidate => ({
    repository: { id: repo, root: repo === 'web' ? paths.webMain : paths.apiMain, name: repo },
    record: { path, head: 'a'.repeat(40), branch: branch === null ? null : `refs/heads/${branch}`, bare, detached: branch === null, locked: false, prunable: false } as never,
    numericId,
  });
  return { root, paths, candidate };
}

describe('matchWorktreeSelector', () => {
  test('selects one worktree by branch, full ref, directory name, number, absolute and relative path', async () => {
    const { paths, candidate } = await layout();
    const candidates = [candidate('web', paths.webMain, 'main', 1), candidate('web', paths.webAuth, 'feat/auth', 2)];
    for (const selector of ['feat/auth', 'refs/heads/feat/auth', 'web-feat-auth', '2', paths.webAuth, '../web-feat-auth']) {
      const outcome = await matchWorktreeSelector({ selector, cwd: paths.webMain, candidates, repositories: ['web'] });
      expect(outcome.outcome === 'selected' && outcome.candidate.record.path, selector).toBe(paths.webAuth);
    }
  });

  test('resolves a relative path against cwd when cwd is inside no worktree', async () => {
    const { root, paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: 'web-feat-auth', cwd: root, candidates: [candidate('web', paths.webAuth, 'feat/auth', 2)], repositories: ['web'],
    });
    expect(outcome.outcome).toBe('selected');
    const relative = await matchWorktreeSelector({
      selector: './api-feat-auth', cwd: root, candidates: [candidate('api', paths.apiAuth, 'x', null)], repositories: ['api'],
    });
    expect(relative.outcome === 'selected' && relative.candidate.record.path).toBe(paths.apiAuth);
  });

  test('matches a symlinked path spelling after realpath', async () => {
    const { root, paths, candidate } = await layout();
    await symlink(paths.webAuth, join(root, 'link'));
    const outcome = await matchWorktreeSelector({
      selector: join(root, 'link'), cwd: root, candidates: [candidate('web', paths.webAuth, 'feat/auth', 2)], repositories: ['web'],
    });
    expect(outcome.outcome).toBe('selected');
  });

  test('counts one worktree matched through two forms once', async () => {
    const { paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: 'web-feat-auth', cwd: paths.webMain, candidates: [candidate('web', paths.webAuth, 'web-feat-auth', 2)], repositories: ['web'],
    });
    expect(outcome.outcome).toBe('selected');
  });

  test('refuses a number and a directory name that name different worktrees', async () => {
    const { paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: '13', cwd: paths.webMain,
      candidates: [candidate('web', paths.numbered, 'x', 2), candidate('web', paths.webAuth, 'feat/auth', 13)], repositories: ['web'],
    });
    expect(outcome).toMatchObject({ outcome: 'refused', error: { code: 'WTM_WORKSPACE_NOT_FOUND', context: { matchCount: 2 } } });
  });

  test('never selects a bare worktree', async () => {
    const { paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: 'web-feat-auth', cwd: paths.webMain, candidates: [candidate('web', paths.webAuth, null, null, true)], repositories: ['web'],
    });
    expect(outcome).toMatchObject({ outcome: 'refused', error: { context: { matchCount: 0, matches: [] } } });
  });

  test('an ambiguity across repositories suggests --repo for each, with every match listed', async () => {
    const { root, paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: 'feat/auth', cwd: root,
      candidates: [candidate('web', paths.webAuth, 'feat/auth', 2), candidate('api', paths.apiAuth, 'feat/auth', 2)],
      repositories: ['api', 'web'],
      withRepo: (repo) => ['wtm', 'start', 'dev', '--worktree', 'feat/auth', '--repo', repo],
    });
    expect(outcome).toMatchObject({
      outcome: 'refused',
      error: {
        code: 'WTM_WORKSPACE_NOT_FOUND',
        context: {
          selector: 'feat/auth', repositories: ['api', 'web'], matchCount: 2,
          matches: [
            { repo: 'api', branch: 'feat/auth', path: paths.apiAuth, numericId: 2 },
            { repo: 'web', branch: 'feat/auth', path: paths.webAuth, numericId: 2 },
          ],
        },
        remediation: [
          { kind: 'command-suggestion', argv: ['wtm', 'start', 'dev', '--worktree', 'feat/auth', '--repo', 'api'] },
          { kind: 'command-suggestion', argv: ['wtm', 'start', 'dev', '--worktree', 'feat/auth', '--repo', 'web'] },
        ],
      },
    });
  });

  test('an ambiguity inside one repository asks for a path and suggests no command', async () => {
    const { paths, candidate } = await layout();
    const outcome = await matchWorktreeSelector({
      selector: 'feat/auth', cwd: paths.webMain,
      candidates: [candidate('web', paths.webAuth, 'feat/auth', 2), candidate('web', paths.apiAuth, 'feat/auth', 3)], repositories: ['web'],
    });
    expect(outcome.outcome === 'refused' && outcome.error.message).toContain('Name it by path');
    expect(outcome.outcome === 'refused' && outcome.error.remediation).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/worktree-selector.test.ts`
Expected: FAIL — module `../worktree-selector` not found.

- [ ] **Step 3: Implement `worktree-selector.ts` (matching, collection, workspace lookup)**

```ts
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  containsPath, listGitWorktrees, nameRepositories, resolveFeatureMembers, resolveWorkspaceConfig,
  SQLiteStateStore, WtmConfigError,
  type GitWorktreeRecord, type RepositoryRecord, type WorkspaceRecord,
} from '@wtm/core';
import type { WtmError } from '@wtm/protocol';

// (types exactly as in Interfaces above)

/** The registered workspace `cwd` belongs to: through the innermost registered worktree, else by root. */
export function workspaceContaining(store: SQLiteStateStore, cwd: string): WorkspaceRecord | undefined {
  // body moved verbatim from packages/cli/src/commands/create-feature.ts:498-512
}

export async function matchWorktreeSelector(input: {
  selector: string; cwd: string; candidates: readonly SelectorCandidate[]; repositories: readonly string[];
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
```

Then `collectSelectorCandidates`:

```ts
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
```

In `packages/cli/src/commands/create-feature.ts`, delete the local `workspaceContaining` (lines 498-512) and add `import { workspaceContaining } from '../worktree-selector';`. Remove imports that become unused there (`containsPath` only if nothing else uses it — check with typecheck).

- [ ] **Step 4: Add collection tests on a real repository** (same test file)

Use `createGitSafetyFixture` from `packages/testkit/src/git-fixture.ts` (it provides `root`, `repoPath`, `linkedWorktreePath`, `cleanup()`; `linkedWorktreePath` is on branch `feature/safe`):

```ts
import { SQLiteStateStore } from '@wtm/core';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { collectSelectorCandidates } from '../worktree-selector';

describe('collectSelectorCandidates', () => {
  test('inside a repository, collects that repository without state and without numbers', async () => {
    const fixture = await createGitSafetyFixture();
    try {
      const collected = await collectSelectorCandidates({ cwd: fixture.linkedWorktreePath, store: null, globalConfigPath: join(fixture.root, 'config.toml') });
      expect(collected.outcome).toBe('collected');
      if (collected.outcome !== 'collected') return;
      expect(collected.candidates.map(({ record }) => record.path).sort()).toEqual([fixture.repoPath, fixture.linkedWorktreePath].sort());
      expect(collected.candidates.every(({ numericId }) => numericId === null)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('--repo without state is WTM_NOT_INITIALIZED', async () => {
    const fixture = await createGitSafetyFixture();
    try {
      const collected = await collectSelectorCandidates({ cwd: fixture.repoPath, repo: 'web', store: null, globalConfigPath: join(fixture.root, 'config.toml') });
      expect(collected).toMatchObject({ outcome: 'refused', error: { code: 'WTM_NOT_INITIALIZED' } });
    } finally {
      await fixture.cleanup();
    }
  });

  test('outside any repository and workspace is WTM_WORKSPACE_NOT_FOUND', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-selector-none-')));
    roots.push(root);
    const collected = await collectSelectorCandidates({ cwd: root, store: null, globalConfigPath: join(root, 'config.toml') });
    expect(collected).toMatchObject({ outcome: 'refused', error: { code: 'WTM_WORKSPACE_NOT_FOUND' } });
  });
});
```

Workspace-scope collection, `--repo` resolution and numbers are exercised with a registered multi-repository workspace in Task 6's scenario.

- [ ] **Step 5: Run to verify pass**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/worktree-selector.test.ts packages/cli/src/__tests__/create-feature.test.ts packages/cli/src/__tests__/create-feature-recovery.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/worktree-selector.ts packages/cli/src/__tests__/worktree-selector.test.ts packages/cli/src/commands/create-feature.ts
git commit -m "feat(cli): one worktree selector module with candidate collection (item 47)"
```

---

### Task 3: `remove` and `analyze` use the shared selector

**Files:**
- Modify: `packages/cli/src/commands/remove.ts:76-90,217-238` (delete `WorktreeSelectorError`, `resolveExplicitSelector`, `canonicalSelectorPath`)
- Modify: `packages/cli/src/main.ts` — `runProductionAnalyze` selector branch (~879-885), `resolveAnalysisSelector` (~944-966, delete), `runProductionRemove` numeric branch (~1000-1025) and `numericSelectorPath` (~1056-1065, delete)
- Test: `packages/cli/src/commands/__tests__/remove.test.ts`, `packages/cli/src/__tests__/full-workflow.scenario.ts` (existing analyze selector assertions must still pass), new cases in `packages/cli/src/__tests__/worktree-selector.test.ts`

**Interfaces:**
- Consumes: `matchWorktreeSelector`, `collectSelectorCandidates`, `SelectorCandidate` (Task 2).
- Produces: `RemoveCommandInput` gains `candidates?: readonly SelectorCandidate[]` and `repositories?: readonly string[]`. When `candidates` is absent, `runRemoveCommand` builds them from `listGitWorktrees(input.repoPath)` with `numericId: null` and `repository: { id: null, root: topology[0].path, name: basename(topology[0].path) }`, which keeps every existing `remove.test.ts` call working.

- [ ] **Step 1: Write failing regression tests**

In `remove.test.ts`, add:

```ts
test('a directory name two worktrees share is refused with both listed, and removes nothing', async () => {
  const fixture = await createFixture();
  // `createGitSafetyFixture` puts the linked worktree at `<root>/linked feature`; a second worktree
  // in a subdirectory gets the same directory name.
  const twin = join(fixture.root, 'twin', basename(fixture.linkedWorktreePath));
  await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'twin', twin]);

  const envelope = await runRemoveCommand({ ...input(fixture), selector: basename(fixture.linkedWorktreePath) });

  expect(envelope).toMatchObject({
    ok: false,
    errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { selector: basename(fixture.linkedWorktreePath), matchCount: 2 } }],
  });
  await expectPreserved(fixture);
  expect(await pathExists(twin)).toBe(true);
});

test('a relative path selector still resolves against the worktree containing the repo path', async () => {
  const fixture = await createFixture();

  const envelope = await runRemoveCommand({ ...input(fixture), selector: `../${basename(fixture.linkedWorktreePath)}` });

  expect(envelope.ok).toBe(true);
});
```

Add `import { basename, join } from 'node:path';` to the test file's imports.

In `worktree-selector.test.ts`, add an analyze-level test through `runCli` against `createGitSafetyFixture` with `analysisDatabasePath` pointing at a non-existent file in the fixture root:

```ts
test('analyze accepts a directory name and refuses an ambiguous selector', async () => {
  const fixture = await createGitSafetyFixture();
  try {
    const run = async (selector: string) => {
      let out = '';
      await runCli(['analyze', selector, '--json'], {
        cwd: fixture.repoPath, analysisDatabasePath: join(fixture.root, 'absent.db'),
        stdout: (value) => { out += value; }, stderr: () => {},
      });
      return JSON.parse(out);
    };
    expect((await run(basename(fixture.linkedWorktreePath))).ok).toBe(true);
    await fixture.git(fixture.repoPath, ['worktree', 'add', '-b', 'twin', join(fixture.root, 'twin', basename(fixture.linkedWorktreePath))]);
    expect(await run(basename(fixture.linkedWorktreePath))).toMatchObject({ ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { matchCount: 2 } }] });
  } finally {
    await fixture.cleanup();
  }
});
```

(`GitSafetyFixture.git(repoPath, args)` is async and returns `{ stdout, ... }`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/remove.test.ts packages/cli/src/__tests__/worktree-selector.test.ts`
Expected: FAIL — `context.matchCount` absent; analyze by directory name returns `ok: false`.

- [ ] **Step 3: Implement**

`remove.ts`:
- Delete `WorktreeSelectorError`, `resolveExplicitSelector`, `canonicalSelectorPath`; drop now-unused imports (`realpath`, `isAbsolute`, `resolve` if unused).
- At the top of `runRemoveCommand`'s `try`:

```ts
const candidates = input.candidates ?? (await listGitWorktrees(input.repoPath)).map((record, _, topology) => ({
  repository: { id: null, root: topology[0]?.path ?? input.repoPath, name: basename(topology[0]?.path ?? input.repoPath) },
  record,
  numericId: null,
}));
const matched = await matchWorktreeSelector({
  selector: input.selector, cwd: input.repoPath, candidates, repositories: input.repositories ?? [basename(candidates[0]?.repository.root ?? input.repoPath)],
});
if (matched.outcome === 'refused') return removalFailure(input, matched.error);
const selected = matched.candidate.record;
```

where `removalFailure` builds the same failure envelope the existing catch path builds for a coded error (reuse that code path: the existing `catch` turns errors into envelopes through `toGitSafetyError`; build `{ schemaVersion: 1, ok: false, command: 'remove', scope: commandScope(input), data: null, warnings, errors: [error] }` directly, matching the shape the catch produces today).

`main.ts` `runProductionRemove`:
- Replace the whole `if (/^\d+$/.test(selector)) { ... }` block and the `let selector = input.selector;` with candidate collection:

```ts
const collected = await collectSelectorCandidates({ cwd: input.cwd, store, globalConfigPath: input.globalConfigPath });
if (collected.outcome === 'refused') return operationFailure('remove', false, collected.error);
```

and pass `candidates: collected.candidates, repositories: collected.repositories, selector: input.selector` to `runRemoveCommand`. Keep `repoPath: repositoryRoot`. Delete `numericSelectorPath`.

Behaviour kept: a numeric selector with no store used to return `WTM_NOT_INITIALIZED` ("state is unavailable"). Keep that exact early return before collection: `if (/^\d+$/.test(input.selector) && store === null) return stateFailure('remove', false);`.

`main.ts` `runProductionAnalyze`, the non-aggregate branch:

```ts
const collected = await collectSelectorCandidates({ cwd: input.cwd, store, globalConfigPath: input.globalConfigPath });
if (collected.outcome === 'refused') return operationFailure('analyze', false, collected.error);
if (input.selector === undefined) {
  const record = topology.find(({ path }) => containsPath(path, resolve(input.cwd)));
  if (record !== undefined) selected.push({ repoPath: repositoryRoot, record });
} else {
  const matched = await matchWorktreeSelector({ selector: input.selector, cwd: input.cwd, candidates: collected.candidates, repositories: collected.repositories });
  if (matched.outcome === 'refused') return operationFailure('analyze', false, matched.error);
  selected.push({ repoPath: repositoryRoot, record: matched.candidate.record });
}
```

The store for analyze is opened today only for `--global` or an all-digit selector; keep that rule (numbers need it, nothing else does). Delete `resolveAnalysisSelector`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/remove.test.ts packages/cli/src/commands/__tests__/analyze.test.ts packages/cli/src/__tests__/worktree-selector.test.ts packages/cli/src/__tests__/full-workflow.test.ts packages/cli/src/__tests__/production-commands.test.ts packages/cli/src/__tests__/main.test.ts && bun run typecheck && bun run lint`
Expected: PASS. `full-workflow` still analyzes by branch, by `../../linked-feature` from `repo/src`, and by absolute path.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/remove.ts packages/cli/src/main.ts packages/cli/src/commands/__tests__/remove.test.ts packages/cli/src/__tests__/worktree-selector.test.ts
git commit -m "refactor(cli): remove and analyze resolve worktrees through the shared selector (item 47)"
```

---

### Task 4: `--worktree` and `--repo` on the task commands

**Files:**
- Modify: `packages/cli/src/worktree-selector.ts` (add `resolveTaskTarget`)
- Modify: `packages/cli/src/main.ts` — `CliDependencies` (~line 119), `resolve`/`run` actions (~236-262), `start`/`stop`/`restart`/`logs`/`exec` actions (~374-424)
- Test: `packages/cli/src/commands/__tests__/runtime.test.ts`, `packages/cli/src/__tests__/worktree-selector.test.ts`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:

```ts
export type TaskTarget =
  | { outcome: 'resolved'; cwd: string }
  | { outcome: 'refused'; error: WtmError };
export function resolveTaskTarget(input: {
  cwd: string;
  /** The invoked command as typed, without the target flags: ['wtm', 'start', 'dev']. */
  argv: readonly string[];
  worktree?: string;
  repo?: string;
  databasePath: string;
  globalConfigPath: string;
}): Promise<TaskTarget>;
```

- `CliDependencies.taskTargetDatabasePath?: string` and `CliDependencies.taskTargetGlobalConfigPath?: string`.

- [ ] **Step 1: Write failing tests**

In `runtime.test.ts`:

```ts
test('--repo without --worktree is refused before any daemon request', async () => {
  const calls: unknown[] = [];
  const client: RuntimeDaemonClient = { request: async (command, args) => { calls.push(args); return success(command); } };
  const output = capture();

  const code = await runCli(['start', 'dev', '--repo', 'api', '--json'], {
    cwd: '/repo/wt', runtimeClient: client, taskTargetDatabasePath: '/nonexistent/wtm/state.db', ...output,
  });

  expect(code).toBe(2);
  expect(JSON.parse(output.out())).toMatchObject({ ok: false, command: 'start', errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  expect(calls).toEqual([]);
});
```

Add `taskTargetDatabasePath: '/nonexistent/wtm/state.db'` to every existing `runCli` call in `runtime.test.ts` so no test opens the default state path.

In `worktree-selector.test.ts`, against `createGitSafetyFixture` with `databasePath: join(fixture.root, 'absent.db')`:

```ts
describe('resolveTaskTarget', () => {
  test('without flags, returns cwd unchanged', async () => {
    const fixture = await createGitSafetyFixture();
    try {
      expect(await resolveTaskTarget({ cwd: fixture.repoPath, argv: ['wtm', 'start', 'dev'], databasePath: join(fixture.root, 'absent.db'), globalConfigPath: join(fixture.root, 'c.toml') }))
        .toEqual({ outcome: 'resolved', cwd: fixture.repoPath });
    } finally { await fixture.cleanup(); }
  });

  test('--worktree resolves to the selected worktree root', async () => {
    const fixture = await createGitSafetyFixture();
    try {
      expect(await resolveTaskTarget({ cwd: fixture.repoPath, argv: ['wtm', 'start', 'dev'], worktree: 'feature/safe', databasePath: join(fixture.root, 'absent.db'), globalConfigPath: join(fixture.root, 'c.toml') }))
        .toEqual({ outcome: 'resolved', cwd: fixture.linkedWorktreePath });
    } finally { await fixture.cleanup(); }
  });
});
```

The workspace-root refusal (§4) needs a registered multi-repository workspace and is covered in Task 6's scenario.

- [ ] **Step 2: Run to verify failure**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/runtime.test.ts packages/cli/src/__tests__/worktree-selector.test.ts`
Expected: FAIL — unknown option `--repo`; `resolveTaskTarget` not exported.

- [ ] **Step 3: Implement `resolveTaskTarget`**

```ts
export async function resolveTaskTarget(input: {
  cwd: string; argv: readonly string[]; worktree?: string; repo?: string; databasePath: string; globalConfigPath: string;
}): Promise<TaskTarget> {
  if (input.repo !== undefined && input.worktree === undefined) {
    return { outcome: 'refused', error: { code: 'WTM_CONFIG_INVALID', severity: 'error',
      message: '--repo names the repository of --worktree; give --worktree as well.', context: { repo: input.repo } } };
  }
  const store = openReadonlyStore(input.databasePath);
  try {
    if (input.worktree !== undefined) {
      const collected = await collectSelectorCandidates({
        cwd: input.cwd, store, globalConfigPath: input.globalConfigPath, ...(input.repo === undefined ? {} : { repo: input.repo }),
      });
      if (collected.outcome === 'refused') return collected;
      const worktree = input.worktree;
      const matched = await matchWorktreeSelector({
        selector: worktree, cwd: input.cwd, candidates: collected.candidates, repositories: collected.repositories,
        withRepo: (repo) => [...input.argv, '--worktree', worktree, '--repo', repo],
      });
      return matched.outcome === 'refused' ? matched : { outcome: 'resolved', cwd: matched.candidate.record.path };
    }
    if (store === null) return { outcome: 'resolved', cwd: input.cwd };
    const workspace = workspaceContaining(store, input.cwd);
    const current = resolve(input.cwd);
    if (workspace === undefined || store.listWorktrees().some(({ path }) => containsPath(path, current))) {
      return { outcome: 'resolved', cwd: input.cwd };
    }
    if (await listGitWorktrees(input.cwd).then((topology) => topology.some(({ path }) => containsPath(path, current)), () => false)) {
      return { outcome: 'resolved', cwd: input.cwd };
    }
    const collected = await collectSelectorCandidates({ cwd: input.cwd, store, globalConfigPath: input.globalConfigPath });
    const candidates = collected.outcome === 'collected'
      ? collected.candidates.filter(({ record }) => !record.bare).map(({ repository, record, numericId }) => ({
        repo: repository.name, branch: record.branch === null ? null : record.branch.replace(/^refs\/heads\//, ''), path: record.path, numericId,
      }))
      : [];
    return { outcome: 'refused', error: {
      code: 'WTM_WORKSPACE_NOT_FOUND', severity: 'error',
      message: 'This is a workspace root, not a worktree. Name the target with `--worktree <selector>`.',
      context: { cwd: input.cwd, workspace: workspace.name, candidates },
      remediation: [{ kind: 'command-suggestion', argv: [...input.argv, '--worktree', '<selector>'] }],
    } };
  } finally {
    store?.close();
  }
}

function openReadonlyStore(databasePath: string): SQLiteStateStore | null {
  if (!existsSync(databasePath)) return null;
  try {
    return new SQLiteStateStore(databasePath, { readonly: true });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire the flags in `main.ts`**

Add to `CliDependencies`:

```ts
  /** State and global config the task commands' `--worktree`/`--repo` resolve against. */
  taskTargetDatabasePath?: string;
  taskTargetGlobalConfigPath?: string;
```

Add near `addReadinessOptions`:

```ts
interface TargetOptions { worktree?: string; repo?: string }

function addTargetOptions(command: Command): void {
  command.option('--worktree <selector>', 'act on this worktree: branch, directory name, number or path');
  command.option('--repo <name>', 'the repository of --worktree, when its branch exists in several');
}
```

Inside `createCli`, after `cwd` is defined:

```ts
  const taskTarget = async (argv: readonly string[], options: TargetOptions) => await resolveTaskTarget({
    cwd, argv,
    ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    databasePath: dependencies.taskTargetDatabasePath ?? defaultProductionRuntimePaths().databasePath,
    globalConfigPath: dependencies.taskTargetGlobalConfigPath ?? defaultProductionRuntimePaths().globalConfigPath,
  });
  const refusedTarget = (command: string, error: WtmError): JsonEnvelope<null> =>
    ({ schemaVersion: 1, ok: false, command, data: null, warnings: [], errors: [error] });
```

For each of `resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`: call `addTargetOptions(<command>)`, extend the action's options type with `& TargetOptions`, and begin the action with (shown for `start`):

```ts
    const target = await taskTarget(['wtm', 'start', taskName], options);
    if (target.outcome === 'refused') {
      renderRuntime(refusedTarget('start', target.error), runtimeJson(program, options));
      return;
    }
```

then replace `cwd` with `cwd: target.cwd` in that action's runner input. The argv per command: `['wtm', 'resolve', taskName]`, `['wtm', 'run', taskName]` (plus `'--enqueue'` when `options.enqueue`), `['wtm', 'stop', ...(taskName === undefined ? [] : [taskName])]`, `['wtm', 'restart', taskName]`, `['wtm', 'logs', ...(taskName === undefined ? [] : [taskName])]`, `['wtm', 'exec', '--', ...argv]` for exec. For `exec`, the remediation must put `--worktree` before `--`; build it as `['wtm', 'exec']` and let `resolveTaskTarget` append, then append `'--', ...argv` is not possible after — so pass `argv: ['wtm', 'exec']` and accept that the suggestion omits the raw command. For `logs --follow`, run the target check before `followLogs`.

Check `renderRuntime`'s exit code for a `WTM_CONFIG_INVALID` envelope is 2 (it uses `exitCodeForEnvelope`); the runtime test asserts it.

- [ ] **Step 5: Run to verify pass**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/runtime.test.ts packages/cli/src/__tests__/worktree-selector.test.ts packages/cli/src/__tests__/main.test.ts packages/cli/src/__tests__/skill-reference.test.ts && bun run typecheck && bun run lint`
Expected: PASS. (`skill-reference.test.ts` exists only once item 53 is merged; skip it if absent.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/worktree-selector.ts packages/cli/src/main.ts packages/cli/src/commands/__tests__/runtime.test.ts packages/cli/src/__tests__/worktree-selector.test.ts
git commit -m "feat(cli): --worktree and --repo on the task commands, and an actionable workspace-root refusal (item 47)"
```

---

### Task 5: Shell completion

**Files:**
- Modify: `packages/cli/src/commands/completion.ts`
- Modify: `packages/cli/src/main.ts` — `__complete` command (~703-720), `productionCompletionData`, `productionTaskNames`, `productionWorktreeSelectors`
- Test: `packages/cli/src/commands/__tests__/completion.test.ts`, `packages/cli/src/__tests__/completion-production.test.ts`

**Interfaces:**
- Consumes: `resolveTaskTarget`, `collectSelectorCandidates`, `workspaceContaining` (Tasks 2 and 4), `nameRepositories` (Task 1).
- Produces: `SUPPORTED_COMPLETION_KINDS = ['tasks', 'worktrees', 'repos', 'repo-names']`; `CliDependencies.completionDataRunner` input gains `worktree?: string; repo?: string`.

- [ ] **Step 1: Write failing tests** (in `completion.test.ts`)

```ts
test('completes --worktree and --repo values on the task commands in every shell', () => {
  const commands = ['resolve', 'run', 'start', 'stop', 'restart', 'logs', 'exec', 'analyze', 'remove', 'forget'];
  for (const shell of ['bash', 'zsh', 'fish']) {
    const result = renderCompletionScript({ shell, binaryName: 'wtm', commands });
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    expect(result.script, shell).toContain('--worktree');
    expect(result.script, shell).toContain('wtm __complete repo-names');
  }
});

test('passes --worktree and --repo already on the line to task-name completion', () => {
  const bash = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: ['start'] });
  const zsh = renderCompletionScript({ shell: 'zsh', binaryName: 'wtm', commands: ['start'] });
  const fish = renderCompletionScript({ shell: 'fish', binaryName: 'wtm', commands: ['start'] });
  expect(bash.ok && bash.script).toContain('__complete tasks "${target[@]}"');
  expect(zsh.ok && zsh.script).toContain('__complete tasks ${target[@]}');
  expect(fish.ok && fish.script).toContain('__complete tasks $target');
});

test('omits flag-value completion when no task command is registered', () => {
  const result = renderCompletionScript({ shell: 'bash', binaryName: 'wtm', commands: ['forget'] });
  expect(result.ok && result.script).not.toContain('--worktree');
});
```

Update the existing `accepts every supported completion data kind` test to include `repo-names`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/completion.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the scripts**

In `completion.ts`:
- `SUPPORTED_COMPLETION_KINDS = ['tasks', 'worktrees', 'repos', 'repo-names'] as const;`
- `const targetFlagCommands = ['resolve', 'run', 'start', 'restart', 'stop', 'logs', 'exec'] as const;`

bash — at the start of `_${bin}_completion`, after `cword=$COMP_CWORD`, when `present(commands, targetFlagCommands).length > 0`, insert:

```bash
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "$prev" in
    --worktree) COMPREPLY=( $(compgen -W "$(${bin} __complete worktrees 2>/dev/null)" -- "$cur") ); return 0 ;;
    --repo) COMPREPLY=( $(compgen -W "$(${bin} __complete repo-names 2>/dev/null)" -- "$cur") ); return 0 ;;
  esac
  local target=() i
  for (( i=2; i<cword; i++ )); do
    case "\${words[i]}" in
      --worktree|--repo) target+=("\${words[i]}" "\${words[i+1]}") ;;
    esac
  done
```

and change the task arm body to `COMPREPLY=( $(compgen -W "$(${bin} __complete tasks "\${target[@]}" 2>/dev/null)" -- "$cur") )`. When no target command is present, keep the task arm exactly as today (no `target` variable).

zsh — after `local -a dynamic`, when target commands are present:

```zsh
  case "\${words[CURRENT-1]}" in
    --worktree) dynamic=(\${(f)"$(${bin} __complete worktrees 2>/dev/null)"}); _describe 'worktree' dynamic; return ;;
    --repo) dynamic=(\${(f)"$(${bin} __complete repo-names 2>/dev/null)"}); _describe 'repository' dynamic; return ;;
  esac
  local -a target
  local i
  for (( i=3; i<CURRENT; i++ )); do
    case "\${words[i]}" in
      --worktree|--repo) target+=("\${words[i]}" "\${words[i+1]}") ;;
    esac
  done
```

and the tasks arm runs `${bin} __complete tasks \${target[@]} 2>/dev/null`.

fish — add `function __${bin}_complete_repo_names; ${bin} __complete repo-names 2>/dev/null; end`; replace `__${bin}_complete_tasks` with:

```fish
function __${bin}_complete_tasks
    set -l tokens (commandline -opc)
    set -l target
    for i in (seq (count $tokens))
        if contains -- $tokens[$i] --worktree --repo; and test $i -lt (count $tokens)
            set -a target $tokens[$i] $tokens[(math $i + 1)]
        end
    end
    ${bin} __complete tasks $target 2>/dev/null
end
```

and, when target commands are present:

```
complete -c ${bin} -n "__fish_seen_subcommand_from <target commands>" -l worktree -r -a "(__${bin}_complete_worktrees)"
complete -c ${bin} -n "__fish_seen_subcommand_from <target commands>" -l repo -r -a "(__${bin}_complete_repo_names)"
```

Every emitted `${...}` for the shell must stay escaped as `\${...}` inside the TypeScript template literal, as the existing code does.

- [ ] **Step 4: Implement the data side in `main.ts`**

- `__complete <kind>` gains `.option('--worktree <selector>')` and `.option('--repo <name>')`, and passes `{ kind, cwd, ...worktree, ...repo }` to `completionDataRunner` (spread optional fields).
- `productionCompletionData(kind, cwd, databasePath, target: { worktree?: string; repo?: string })`:
  - `tasks`: when `target.worktree` is set, `const resolved = await resolveTaskTarget({ cwd, argv: ['wtm'], ...target, databasePath, globalConfigPath })`; on `refused` return `[]`; otherwise call `productionTaskNames(resolved.cwd, databasePath)`.
  - `worktrees`: rewrite `productionWorktreeSelectors` on `collectSelectorCandidates({ cwd, store, globalConfigPath })`: emit each non-bare candidate's short branch name (non-empty) and each non-null `numericId` as a string, de-duplicated and sorted with `compareNames`. From inside a repository this is the same set as today; from a workspace root it covers every repository.
  - `repo-names`: open the store; `workspaceContaining(store, cwd)`; `resolveWorkspaceConfig` for its root; return `[...nameRepositories(...).values()]` sorted; `[]` on any failure.
- Update `completion-production.test.ts` with one case: `__complete repo-names` outside any workspace prints nothing and exits 0.

- [ ] **Step 5: Run to verify pass**

Run: `bun test --timeout 60000 packages/cli/src/commands/__tests__/completion.test.ts packages/cli/src/__tests__/completion-production.test.ts packages/cli/src/__tests__/main.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/completion.ts packages/cli/src/main.ts packages/cli/src/commands/__tests__/completion.test.ts packages/cli/src/__tests__/completion-production.test.ts
git commit -m "feat(cli): complete --worktree and --repo values and target-aware task names (item 47)"
```

---

### Task 6: Multi-repository scenario

**Files:**
- Create: `packages/cli/src/__tests__/worktree-selector.scenario.ts`
- Create: `packages/cli/src/__tests__/worktree-selector-scenario.test.ts`

**Interfaces:**
- Consumes: the CLI as a whole through `runCli`; `runScenario` from `packages/testkit/src/scenario-child.ts`.

- [ ] **Step 1: Write the scenario**

Base it on `packages/cli/src/__tests__/create-feature.scenario.ts` lines 1-77 (temporary root, isolated `HOME`, `GIT_CONFIG_GLOBAL`, `invoke` helper, `wtm init --yes --json` with a reconcile-only `runtimeClient`), with repositories `web` and `api`. Then:

```ts
// A task to resolve, so `resolve --worktree` has something to report the working directory of.
await writeFile(join(workspaceRoot, 'wtm.toml'), `${await readFile(join(workspaceRoot, 'wtm.toml'), 'utf8')}\n[tasks.dev]\nrun = ["node", "-e", "0"]\n`);
await invoke(['create', 'feat/auth', '--repos', 'web,api', '--json']);

const requests: Array<{ command: string; arguments: any }> = [];
const recording = {
  request: async (command: string, args: unknown) => {
    requests.push({ command, arguments: args });
    if (command === 'exec') return { schemaVersion: 1, ok: true, command, data: { argv: ['true'], cwd: (args as { cwd: string }).cwd, envDelta: {} }, warnings: [], errors: [] };
    return { schemaVersion: 1, ok: true, command, data: { accepted: true }, warnings: [], errors: [] };
  },
} as never;
const target = { taskTargetDatabasePath: databasePath, taskTargetGlobalConfigPath: join(dataRoot, 'config.toml'), runtimeClient: recording, execForeground: async () => ({ exitCode: 0, signal: null }) };

const apiAuth = join(workspaceRoot, 'api-feat-auth');
const results = {
  start: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  stop: await invoke(['stop', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  restart: await invoke(['restart', 'dev', '--worktree', 'api-feat-auth', '--json'], target),
  logs: await invoke(['logs', 'dev', '--worktree', apiAuth, '--json'], target),
  exec: await invoke(['exec', '--worktree', 'feat/auth', '--repo', 'api', '--json', '--', 'true'], target),
  enqueue: await invoke(['run', 'dev', '--enqueue', '--worktree', 'feat/auth', '--repo', 'api', '--json'], target),
  ambiguous: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--json'], target),
  unknownRepo: await invoke(['start', 'dev', '--worktree', 'feat/auth', '--repo', 'nope', '--json'], target),
  workspaceRoot: await invoke(['start', 'dev', '--json'], target),
  resolveTarget: await invoke(['resolve', 'dev', '--worktree', 'feat/auth', '--repo', 'web', '--json'], target),
};
process.stdout.write(`${JSON.stringify({ apiAuth, webAuth: join(workspaceRoot, 'web-feat-auth'), requests, results })}\n`);
```

(The worktree directory names `api-feat-auth`/`web-feat-auth` are what `create-feature.scenario.ts` already relies on; confirm against `created.envelope.data.members[].worktree.path` and use those paths if they differ.)

- [ ] **Step 2: Write the test**

```ts
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runScenario } from '../../../testkit/src/scenario-child';

test('task commands reach the selected worktree of a multi-repository workspace from its root', () => {
  const scenarioPath = fileURLToPath(new URL('./worktree-selector.scenario.ts', import.meta.url));
  const result = runScenario('node', ['--import', 'tsx', scenarioPath]);
  expect(result.status, result.stderr).toBe(0);
  const { apiAuth, webAuth, requests, results } = JSON.parse(result.stdout);

  for (const name of ['start', 'stop', 'restart', 'logs', 'exec', 'enqueue']) {
    expect(results[name].envelope.ok, name).toBe(true);
  }
  expect(requests.map(({ arguments: args }: { arguments: { cwd: string } }) => args.cwd)).toEqual([apiAuth, apiAuth, apiAuth, apiAuth, apiAuth, apiAuth]);
  expect(results.ambiguous.envelope).toMatchObject({ ok: false, errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', context: { matchCount: 2 } }] });
  expect(results.ambiguous.envelope.errors[0].remediation.map(({ argv }: { argv: string[] }) => argv.at(-1)).sort()).toEqual(['api', 'web']);
  expect(results.unknownRepo.envelope).toMatchObject({ ok: false, errors: [{ code: 'WTM_CONFIG_INVALID' }] });
  expect(results.workspaceRoot.envelope).toMatchObject({
    ok: false,
    errors: [{ code: 'WTM_WORKSPACE_NOT_FOUND', remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'start', 'dev', '--worktree', '<selector>'] }] }],
  });
  expect(results.workspaceRoot.envelope.errors[0].context.candidates.map(({ path }: { path: string }) => path)).toEqual(expect.arrayContaining([apiAuth, webAuth]));
  // `resolve` returns the ResolvedTask (`packages/core/src/runtime/task-resolver.ts`), whose `cwd`
  // is the worktree root for a task with no `cwd` of its own.
  expect(results.resolveTarget.envelope).toMatchObject({ ok: true, data: { cwd: webAuth } });
});
```

The scenario must print exactly one JSON line on stdout (the `invoke` helper captures `runCli`'s own output), as `create-feature.scenario.ts` does.

- [ ] **Step 3: Run**

Run: `bun test --timeout 60000 packages/cli/src/__tests__/worktree-selector-scenario.test.ts`
Expected: PASS. If a request's `cwd` is wrong, fix the implementation in Tasks 2-4, not the assertion.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/__tests__/worktree-selector.scenario.ts packages/cli/src/__tests__/worktree-selector-scenario.test.ts
git commit -m "test(cli): task commands reach the selected worktree from a multi-repository workspace root (item 47)"
```

---

### Task 7: Documentation, skill, CHANGELOG, todo

**Files:**
- Modify: `docs/04-cli-reference.md` (sections for `resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`, `analyze` ~385-388, `remove` ~538-543)
- Modify: `docs/18-errors-json-contract.md`
- Modify: `docs/11-ai-first-skill-integration.md`, `skills/wtm/SKILL.md`
- Modify: `CHANGELOG.md` (`[Unreleased]`: `### Added`, `### Changed`), `todo.md` item 47

- [ ] **Step 1: `docs/04`**

For each of the seven task commands add:

```markdown
`--worktree <selector>` runs the command against another worktree instead of the one containing the
current directory: a branch, a worktree directory name, a registered number, or a path. `--repo
<name>` names the repository when the selector matches worktrees in several; it is refused without
`--worktree`. From a workspace root, a selector searches every repository of the workspace; inside a
repository, only that repository. An ambiguous selector is refused, never guessed.
```

For `exec`, add that the flags go before `--`. Replace the selector sentence of `analyze` and `remove` with: "The selector accepts a branch name, a worktree directory name, a registered numeric worktree ID, an absolute path, or a path relative to the worktree containing the current directory. A selector matching more than one worktree is refused with `WTM_WORKSPACE_NOT_FOUND`." Add under `analyze`: "Before item 47, `analyze` took the first of several matches and did not accept a directory name."

- [ ] **Step 2: `docs/18`**

Add a section "Worktree selector errors" documenting: `WTM_WORKSPACE_NOT_FOUND` with `context.selector`, `context.repoPath`, `context.repositories`, `context.matches` (`[{ repo, branch, path, numericId }]`) and `context.matchCount`; the `--repo` remediation for cross-repository ambiguity; the workspace-root refusal with `context.cwd`, `context.workspace`, `context.candidates` and its `--worktree <selector>` remediation; `WTM_CONFIG_INVALID` for `--repo` without `--worktree` and for an unknown or ambiguous `--repo`; `WTM_NOT_INITIALIZED` for `--repo` without state. State that `remove`'s `context.matches` changed from a number to the array, with the count in `matchCount`.

- [ ] **Step 3: Skill and docs/11**

In `skills/wtm/SKILL.md` (item 53's version):
- Command map rows for `resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`: append "`--worktree <selector>` (`--repo <name>`) targets another worktree."
- Replace the task-command bullet under "Selectors differ by command" with: "`resolve`, `run`, `start`, `stop`, `restart`, `logs`, `exec`: `--worktree <selector>` takes the same forms as `analyze`, and `--repo <name>` names the repository when the branch exists in several. Without it they act on the worktree containing the current directory. From a workspace root they require `--worktree`."
- In "New worktrees", replace "`data.worktree.path` ... is where its commands run." with "Pass `--worktree <branch>` (with `--repo <name>` for a multi-repository feature) to run commands there; do not `cd`."
- Delete the sentence about `git worktree list --porcelain`.

In `docs/11`, add to the agent command contract: "Target another worktree with `--worktree <selector>` instead of changing directory."

Run `bun test --timeout 60000 packages/cli/src/__tests__/skill-reference.test.ts` (present once item 53 is merged).

- [ ] **Step 4: CHANGELOG and todo**

CHANGELOG `### Added`: "`--worktree <selector>` and `--repo <name>` on `resolve`, `run`, `start`, `stop`, `restart`, `logs` and `exec` target another worktree without `cd`, through the selector `analyze` and `remove` use. From a workspace root, the commands refuse without `--worktree` and list the candidates." `### Changed`: "`analyze` and `remove` share one worktree selector: `analyze` accepts a directory name and refuses an ambiguous selector instead of taking the first match; a number and a directory name naming different worktrees are ambiguous for both; `remove`'s selector error reports `matches` as a list and `matchCount`."

`todo.md` item 47: tick every checkbox that is done; the heading becomes `### [x] 47.`; add a dated note naming the corrections in the spec.

- [ ] **Step 5: Commit**

```bash
git add docs/04-cli-reference.md docs/18-errors-json-contract.md docs/11-ai-first-skill-integration.md skills/wtm/SKILL.md CHANGELOG.md todo.md
git commit -m "docs: document --worktree and --repo and the shared selector (item 47)"
```

---

## Self-review notes

- Spec §1 → Task 4; §2 → Tasks 2-3; §3 → Task 2 (`collectSelectorCandidates`) and Task 6; §4 → Task 4 and Task 6; §5 → Task 2 and Task 7; §6 → Task 5; §7 → Task 3; documentation → Task 7; testing → every task, scenario in Task 6.
- Task 7's skill edits depend on item 53 (PR #8). If it is not merged when Task 7 runs, rebase onto `main` first; if it is still unmerged, apply the equivalent edits to the skill that exists and note it in the ledger.
