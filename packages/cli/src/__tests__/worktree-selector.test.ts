import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { runCli } from '../main';
import { collectSelectorCandidates, matchWorktreeSelector, type SelectorCandidate } from '../worktree-selector';

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
    record: {
      path,
      head: 'a'.repeat(40),
      branch: branch === null ? null : `refs/heads/${branch}`,
      bare,
      detached: branch === null,
      lockedReason: null,
      prunableReason: null,
    },
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

describe('analyze through the shared selector', () => {
  test('analyze accepts a directory name and refuses an ambiguous selector', async () => {
    const fixture = await createGitSafetyFixture();
    try {
      const run = async (selector: string) => {
        let out = '';
        await runCli(['analyze', selector, '--json'], {
          cwd: fixture.repoPath, analysisDatabasePath: join(fixture.root, 'absent.db'),
          removalGlobalConfigPath: join(fixture.root, 'absent-global.toml'),
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
});
