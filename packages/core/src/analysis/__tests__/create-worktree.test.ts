import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { listGitWorktrees, runGit } from '../../git/git-runner';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import {
  createWorktree,
  planWorktreeCreation,
  worktreeDirectoryName,
  type WorktreeCreationInput,
} from '../create-worktree';

const workspaceRoot = resolve('/ws');
const mainRoot = join(workspaceRoot, 'repo');

function record(overrides: Partial<GitWorktreeRecord> = {}): GitWorktreeRecord {
  return {
    path: mainRoot,
    head: 'a'.repeat(40),
    branch: 'refs/heads/main',
    bare: false,
    detached: false,
    lockedReason: null,
    prunableReason: null,
    ...overrides,
  };
}

function plan(overrides: Partial<WorktreeCreationInput> = {}) {
  return planWorktreeCreation({
    workspaceRoot,
    mainRoot,
    branch: 'feat/auth',
    topology: [record()],
    branchExists: false,
    pathExists: () => false,
    ...overrides,
  });
}

describe('worktreeDirectoryName', () => {
  test('turns a branch into a directory beside its repository', () => {
    expect(worktreeDirectoryName('repo', 'feat/auth')).toBe('repo-feat-auth');
    expect(worktreeDirectoryName('repo', 'release/2026.09.07')).toBe('repo-release-2026.09.07');
  });

  test('refuses a branch that has nothing a directory name can be built from', () => {
    // Not a fallback name: a directory called `repo-` or `repo` would either collide with the
    // repository itself or be unguessable, and both are worse than saying no.
    expect(worktreeDirectoryName('repo', '///')).toBeNull();
    expect(worktreeDirectoryName('repo', '---')).toBeNull();
  });
});

describe('planWorktreeCreation', () => {
  test('computes the path from the workspace root and the repository directory', () => {
    const decision = plan();

    expect(decision).toEqual({
      outcome: 'plan',
      plan: {
        path: join(workspaceRoot, 'repo-feat-auth'),
        branch: 'feat/auth',
        branchRef: 'refs/heads/feat/auth',
        createsBranch: true,
        startPoint: 'a'.repeat(40),
      },
    });
  });

  test('starts a new branch at the main worktree HEAD, not at the caller position', () => {
    // The caller is standing in a linked worktree whose HEAD is a different commit. The plan
    // must not notice: the same command in the same repository has to produce the same branch
    // point from any directory.
    const decision = plan({
      topology: [
        record(),
        record({ path: join(workspaceRoot, 'repo-other'), head: 'b'.repeat(40), branch: 'refs/heads/other' }),
      ],
    });

    expect(decision).toMatchObject({ plan: { startPoint: 'a'.repeat(40) } });
  });

  test('--from names the start point of a new branch', () => {
    expect(plan({ from: 'origin/main' })).toMatchObject({ plan: { startPoint: 'origin/main' } });
  });

  test('an existing branch is checked out rather than started somewhere', () => {
    expect(plan({ branchExists: true }))
      .toMatchObject({ plan: { createsBranch: false, startPoint: null } });
  });

  test('refuses --from for a branch that already exists', () => {
    const decision = plan({ branchExists: true, from: 'origin/main' });

    expect(decision).toMatchObject({ outcome: 'refused', error: { code: 'WTM_CONFIG_INVALID' } });
  });

  test('refuses a branch another worktree already has checked out, and names that worktree', () => {
    const holder = join(workspaceRoot, 'repo-elsewhere');
    const decision = plan({
      topology: [record(), record({ path: holder, branch: 'refs/heads/feat/auth' })],
    });

    expect(decision).toMatchObject({
      outcome: 'refused',
      error: { code: 'GIT_BRANCH_IN_USE', context: { worktreePath: holder } },
    });
  });

  test('refuses an occupied target path, and carries the path', () => {
    const target = join(workspaceRoot, 'repo-feat-auth');
    const decision = plan({ pathExists: (path) => path === target });

    expect(decision).toMatchObject({
      outcome: 'refused',
      error: { code: 'WTM_WORKTREE_PATH_OCCUPIED', context: { path: target } },
    });
  });

  test('two branches that slug alike are refused by the occupied path, not silently renamed', () => {
    const target = join(workspaceRoot, 'repo-feat-auth');
    expect(plan({ branch: 'feat-auth' })).toMatchObject({ plan: { path: target } });
    expect(plan({ branch: 'feat-auth', pathExists: (path) => path === target }))
      .toMatchObject({ outcome: 'refused', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED' } });
  });

  test('accepts a fully qualified ref and reports the short branch name', () => {
    expect(plan({ branch: 'refs/heads/feat/auth' }))
      .toMatchObject({ plan: { branch: 'feat/auth', branchRef: 'refs/heads/feat/auth' } });
  });

  test('reports the first refusal in the documented order when an invocation is wrong twice', () => {
    // --from over an existing branch outranks the occupied path: the user's request itself is
    // contradictory, and telling them about a directory would send them to fix the wrong thing.
    const target = join(workspaceRoot, 'repo-feat-auth');
    expect(plan({ branchExists: true, from: 'main', pathExists: (path) => path === target }))
      .toMatchObject({ error: { code: 'WTM_CONFIG_INVALID' } });
    // And an in-use branch outranks the occupied path for the same reason.
    expect(plan({
      topology: [record(), record({ path: '/ws/held', branch: 'refs/heads/feat/auth' })],
      pathExists: (path) => path === target,
    })).toMatchObject({ error: { code: 'GIT_BRANCH_IN_USE' } });
  });
});

describe('createWorktree', () => {
  const fixtures: GitSafetyFixture[] = [];

  async function fixture(): Promise<GitSafetyFixture> {
    const created = await createGitSafetyFixture();
    fixtures.push(created);
    return created;
  }

  test('creates the worktree the plan describes, on a new branch at the main HEAD', async () => {
    const safety = await fixture();
    const decision = planWorktreeCreation({
      workspaceRoot: safety.root,
      mainRoot: safety.repoPath,
      branch: 'feat/auth',
      topology: await listGitWorktrees(safety.repoPath),
      branchExists: false,
      pathExists: () => false,
    });
    if (decision.outcome !== 'plan') throw new Error('expected a plan');

    const created = await createWorktree(safety.repoPath, decision.plan);

    expect(created.branch).toBe('refs/heads/feat/auth');
    expect(resolve(created.path)).toBe(resolve(join(safety.root, 'main repo-feat-auth')));
    // The main worktree's HEAD, even though `feature/safe` is a different commit.
    expect(created.head).toBe(safety.mainHead);
    await safety.cleanup();
    fixtures.splice(fixtures.indexOf(safety), 1);
  });

  test('--from starts the branch at the named ref', async () => {
    const safety = await fixture();
    const decision = planWorktreeCreation({
      workspaceRoot: safety.root,
      mainRoot: safety.repoPath,
      branch: 'feat/from',
      topology: await listGitWorktrees(safety.repoPath),
      branchExists: false,
      pathExists: () => false,
      from: 'feature/safe',
    });
    if (decision.outcome !== 'plan') throw new Error('expected a plan');

    const created = await createWorktree(safety.repoPath, decision.plan);

    expect(created.head).toBe(safety.featureHead);
    await safety.cleanup();
    fixtures.splice(fixtures.indexOf(safety), 1);
  });

  test('checks out an existing branch rather than recreating it', async () => {
    const safety = await fixture();
    await safety.git(safety.repoPath, ['branch', 'existing', 'HEAD']);
    const decision = planWorktreeCreation({
      workspaceRoot: safety.root,
      mainRoot: safety.repoPath,
      branch: 'existing',
      topology: await listGitWorktrees(safety.repoPath),
      branchExists: true,
      pathExists: () => false,
    });
    if (decision.outcome !== 'plan') throw new Error('expected a plan');

    const created = await createWorktree(safety.repoPath, decision.plan);

    expect(created.branch).toBe('refs/heads/existing');
    const branches = await runGit(safety.repoPath, ['branch', '--list', 'existing']);
    expect(branches.stdout.toString('utf8').trim()).toContain('existing');
    await safety.cleanup();
    fixtures.splice(fixtures.indexOf(safety), 1);
  });

  test('a name Git refuses fails as GIT_COMMAND_FAILED carrying Git own message', async () => {
    const safety = await fixture();

    await expect(createWorktree(safety.repoPath, {
      path: join(safety.root, 'bad'),
      branch: 'feat..auth',
      branchRef: 'refs/heads/feat..auth',
      createsBranch: true,
      startPoint: 'HEAD',
    })).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' });
    await safety.cleanup();
    fixtures.splice(fixtures.indexOf(safety), 1);
  });
});
