import { afterEach, describe, expect, test } from 'bun:test';
import { realpath, rm } from 'node:fs/promises';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { analyzeWorktree, type WorktreeAnalysis } from '../worktree-analysis';

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('analyzeWorktree', () => {
  test('reports a clean pushed linked branch as safe with upstream and base dimensions', async () => {
    const fixture = await createFixture();

    const analysis = await analyze(fixture);

    expect(analysis.identity).toMatchObject({
      path: fixture.linkedWorktreePath,
      isMain: false,
      branchRef: 'refs/heads/feature/safe',
      detached: false,
      headOid: fixture.featureHead,
      lockedReason: null,
      pathExists: true,
      baseRef: 'refs/heads/main',
    });
    expect(analysis.workingTree).toEqual({
      available: true,
      classifications: ['clean'],
      counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, submoduleDirty: 0 },
      paths: { staged: [], unstaged: [], untracked: [], unmerged: [], submoduleDirty: [] },
    });
    expect(analysis.upstream).toEqual({
      configuredRef: 'refs/remotes/origin/feature/safe',
      available: true,
      ahead: 0,
      behind: 0,
    });
    expect(analysis.remotePersistence).toMatchObject({
      allowedRemoteRefs: ['refs/remotes/origin/*'],
      persisted: true,
      containingRefs: ['refs/remotes/origin/feature/safe'],
    });
    expect(analysis.base).toEqual({
      ref: 'refs/heads/main',
      available: true,
      ahead: 1,
      behind: 0,
      uniqueCommits: 1,
      headIsAncestor: false,
      merged: false,
    });
    expect(analysis.safety).toEqual({ readiness: 'SAFE', blockers: [], warnings: [] });
  });

  test('blocks staged changes with their own stable code and paths', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'staged.txt', 'staged\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', 'staged.txt']);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_DIRTY_STAGED']);
    expect(analysis.workingTree.counts.staged).toBe(1);
    expect(analysis.workingTree.paths.staged).toEqual(['staged.txt']);
  });

  test('parses a real staged rename whose source pathname begins with a status-record prefix', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, '? old-name.txt', 'rename source\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', '--', '? old-name.txt']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Add unusual source pathname']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
    await fixture.git(fixture.linkedWorktreePath, ['mv', '--', '? old-name.txt', 'renamed.txt']);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_DIRTY_STAGED']);
    expect(analysis.workingTree.paths.staged).toEqual(['renamed.txt']);
  });

  test('blocks unstaged tracked changes with their own stable code and paths', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'feature.txt', 'changed but unstaged\n');

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_DIRTY_UNSTAGED']);
    expect(analysis.workingTree.counts.unstaged).toBe(1);
    expect(analysis.workingTree.paths.unstaged).toEqual(['feature.txt']);
  });

  test('blocks untracked files with their own stable code and paths', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'untracked.txt', 'untracked\n');

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_UNTRACKED']);
    expect(analysis.workingTree.counts.untracked).toBe(1);
    expect(analysis.workingTree.paths.untracked).toEqual(['untracked.txt']);
  });

  test('blocks ignored files matched by a repository .gitignore', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, '.gitignore', 'ignored.log\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', '.gitignore']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Ignore local logs']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
    await fixture.write(fixture.linkedWorktreePath, 'ignored.log', 'must survive removal\n');

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_UNTRACKED']);
    expect(analysis.workingTree.paths.untracked).toEqual(['ignored.log']);
  });

  test('blocks ignored files matched by the repository info/exclude file', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.repoPath, '.git/info/exclude', 'private.cache\n');
    await fixture.write(fixture.linkedWorktreePath, 'private.cache', 'must survive removal\n');

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_UNTRACKED']);
    expect(analysis.workingTree.paths.untracked).toEqual(['private.cache']);
  });

  test('classifies unresolved paths only as unmerged and preserves the worktree state', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.repoPath, 'README.md', 'main side\n');
    await fixture.git(fixture.repoPath, ['add', 'README.md']);
    await fixture.git(fixture.repoPath, ['commit', '-m', 'Change main side']);
    await fixture.git(fixture.repoPath, ['push', 'origin', 'main']);
    await fixture.write(fixture.linkedWorktreePath, 'README.md', 'feature side\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', 'README.md']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Change feature side']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
    await fixture.git(fixture.linkedWorktreePath, ['merge', 'main'], [1]);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_UNMERGED']);
    expect(analysis.workingTree.counts).toMatchObject({ staged: 0, unstaged: 0, unmerged: 1 });
    expect(analysis.workingTree.paths.unmerged).toEqual(['README.md']);
  });

  test('blocks a dirty submodule through Git porcelain-v2 tracked-change state', async () => {
    const fixture = await createFixture();
    await createDirtySubmodule(fixture);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_DIRTY_UNSTAGED']);
    expect(analysis.workingTree.counts.submoduleDirty).toBe(1);
    expect(analysis.workingTree.paths.submoduleDirty).toEqual(['deps/local-submodule']);
    expect(analysis.safety.blockers[0]?.context).toMatchObject({
      submodulePaths: ['deps/local-submodule'],
    });
  });

  test('blocks a Git-locked linked worktree with a distinct reason', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, [
      'worktree', 'lock', '--reason', 'runtime cleanup in progress', fixture.linkedWorktreePath,
    ]);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_WORKTREE_LOCKED']);
    expect(analysis.safety.blockers[0]?.context).toMatchObject({
      worktreePath: fixture.linkedWorktreePath,
      reason: 'runtime cleanup in progress',
    });
  });

  test('blocks the main worktree independently of its clean and pushed state', async () => {
    const fixture = await createFixture();

    const analysis = await analyzeWorktree({
      repoPath: fixture.repoPath,
      worktreePath: fixture.repoPath,
      baseRef: 'refs/heads/main',
    });

    expect(blockerCodes(analysis)).toEqual(['GIT_MAIN_WORKTREE']);
    expect(analysis.remotePersistence.persisted).toBe(true);
  });

  test('does not classify the first linked worktree of a bare repository as main', async () => {
    const fixture = await createFixture();
    const bareLinkedPath = `${fixture.root}/bare-linked`;
    await fixture.git(fixture.remotePath, [
      'worktree', 'add', '-b', 'feature/bare-linked', bareLinkedPath, 'main',
    ]);

    const analysis = await analyzeWorktree({
      repoPath: fixture.remotePath,
      worktreePath: await realpath(bareLinkedPath),
      baseRef: 'refs/heads/main',
    });

    expect(analysis.identity.isMain).toBe(false);
    expect(blockerCodes(analysis)).not.toContain('GIT_MAIN_WORKTREE');
  });

  test('reports a missing prunable worktree path as unavailable and degraded', async () => {
    const fixture = await createFixture();
    await rm(fixture.linkedWorktreePath, { recursive: true, force: true });

    const analysis = await analyze(fixture);

    expect(analysis.identity).toMatchObject({
      path: fixture.linkedWorktreePath,
      pathExists: false,
      prunableReason: expect.any(String),
    });
    expect(analysis.workingTree).toMatchObject({ available: false, classifications: [] });
    expect(blockerCodes(analysis)).toEqual(['GIT_REPOSITORY_DEGRADED']);
  });

  test('resolves an omitted base from the repository main-worktree branch without hardcoding main', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, ['branch', '-m', 'trunk']);
    await fixture.git(fixture.repoPath, ['push', '-u', 'origin', 'trunk']);

    const analysis = await analyzeWorktree({
      repoPath: fixture.repoPath,
      worktreePath: fixture.linkedWorktreePath,
    });

    expect(analysis.identity.baseRef).toBe('refs/heads/trunk');
    expect(analysis.base).toMatchObject({ ref: 'refs/heads/trunk', available: true });
    expect(blockerCodes(analysis)).toEqual([]);
  });

  test('treats an unavailable explicit base as unknown review state rather than a deletion blocker', async () => {
    const fixture = await createFixture();

    const analysis = await analyzeWorktree({
      repoPath: fixture.repoPath,
      worktreePath: fixture.linkedWorktreePath,
      baseRef: 'refs/heads/does-not-exist',
    });

    expect(analysis.base).toMatchObject({ ref: 'refs/heads/does-not-exist', available: false });
    expect(analysis.safety).toMatchObject({
      readiness: 'REVIEW',
      blockers: [],
      warnings: [{ code: 'GIT_REPOSITORY_DEGRADED', severity: 'warning' }],
    });
  });

  test('blocks a branch HEAD absent from every allowed remote-tracking ref and reports ahead state', async () => {
    const fixture = await createFixture();
    await fixture.write(fixture.linkedWorktreePath, 'local-only.txt', 'local only\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', 'local-only.txt']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Keep this local']);

    const analysis = await analyze(fixture);

    expect(blockerCodes(analysis)).toEqual(['GIT_HEAD_NOT_REMOTE_PERSISTED']);
    expect(analysis.upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect(analysis.remotePersistence.persisted).toBe(false);
    expect(analysis.safety.blockers[0]?.context).toMatchObject({
      branchRef: 'refs/heads/feature/safe',
      allowedRemoteRefs: ['refs/remotes/origin/*'],
    });
  });

  test('uses allowed remote-tracking reachability rather than the configured upstream name', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.linkedWorktreePath, [
      'push', 'origin', 'HEAD:refs/heads/archive/safe',
    ]);

    const analysis = await analyzeWorktree({
      repoPath: fixture.repoPath,
      worktreePath: fixture.linkedWorktreePath,
      baseRef: 'refs/heads/main',
      allowedRemoteRefs: ['refs/remotes/origin/archive/*'],
    });

    expect(analysis.upstream.configuredRef).toBe('refs/remotes/origin/feature/safe');
    expect(analysis.remotePersistence).toMatchObject({
      persisted: true,
      containingRefs: ['refs/remotes/origin/archive/safe'],
    });
    expect(analysis.safety.readiness).toBe('SAFE');
  });

  test('treats a missing upstream as review-only when an allowed remote ref persists HEAD', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.linkedWorktreePath, ['branch', '--unset-upstream']);

    const analysis = await analyze(fixture);

    expect(analysis.upstream).toEqual({ configuredRef: null, available: false, ahead: null, behind: null });
    expect(analysis.remotePersistence.persisted).toBe(true);
    expect(analysis.safety).toMatchObject({
      readiness: 'REVIEW',
      blockers: [],
      warnings: [{ code: 'GIT_UPSTREAM_MISSING', severity: 'warning' }],
    });
  });

  test('distinguishes a remote-persisted detached HEAD from detached local-only commits', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.linkedWorktreePath, ['switch', '--detach']);

    const reachable = await analyze(fixture);

    expect(reachable.identity).toMatchObject({ branchRef: null, detached: true });
    expect(reachable.remotePersistence.persisted).toBe(true);
    expect(reachable.safety.readiness).toBe('REVIEW');
    expect(blockerCodes(reachable)).toEqual([]);

    await fixture.write(fixture.linkedWorktreePath, 'detached-local.txt', 'detached local\n');
    await fixture.git(fixture.linkedWorktreePath, ['add', 'detached-local.txt']);
    await fixture.git(fixture.linkedWorktreePath, ['commit', '-m', 'Detached local commit']);

    const localOnly = await analyze(fixture);

    expect(blockerCodes(localOnly)).toEqual(['GIT_HEAD_NOT_REMOTE_PERSISTED']);
    expect(localOnly.safety.blockers[0]?.context).toMatchObject({ detached: true });
  });

  test('reports behind upstream separately from base uniqueness', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.linkedWorktreePath, ['commit', '--allow-empty', '-m', 'Advance remote feature']);
    await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
    await fixture.git(fixture.linkedWorktreePath, ['reset', '--hard', fixture.featureHead]);

    const analysis = await analyze(fixture);

    expect(analysis.upstream).toMatchObject({ ahead: 0, behind: 1 });
    expect(analysis.base).toMatchObject({ ahead: 1, behind: 0, uniqueCommits: 1, merged: false });
    expect(analysis.remotePersistence.persisted).toBe(true);
    expect(analysis.safety.readiness).toBe('SAFE');
  });

  test('reports a branch tip merged into the configured base without making merge status a blocker', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, ['merge', '--ff-only', 'feature/safe']);
    await fixture.git(fixture.repoPath, ['push', 'origin', 'main']);

    const analysis = await analyze(fixture);

    expect(analysis.base).toEqual({
      ref: 'refs/heads/main',
      available: true,
      ahead: 0,
      behind: 0,
      uniqueCommits: 0,
      headIsAncestor: true,
      merged: true,
    });
    expect(analysis.safety.readiness).toBe('SAFE');
  });
});

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

function analyze(fixture: GitSafetyFixture): Promise<WorktreeAnalysis> {
  return analyzeWorktree({
    repoPath: fixture.repoPath,
    worktreePath: fixture.linkedWorktreePath,
    baseRef: 'refs/heads/main',
  });
}

function blockerCodes(analysis: WorktreeAnalysis): string[] {
  return analysis.safety.blockers.map((blocker) => blocker.code);
}

async function createDirtySubmodule(fixture: GitSafetyFixture): Promise<void> {
  const sourcePath = `${fixture.root}/submodule-source`;
  await fixture.write(sourcePath, 'README.md', 'submodule source\n');
  await fixture.git(sourcePath, ['init', '--initial-branch=main']);
  await fixture.git(sourcePath, ['config', 'user.name', 'WTM Test']);
  await fixture.git(sourcePath, ['config', 'user.email', 'wtm-test@example.invalid']);
  await fixture.git(sourcePath, ['add', 'README.md']);
  await fixture.git(sourcePath, ['commit', '-m', 'Initialize local submodule']);
  await fixture.git(fixture.linkedWorktreePath, [
    '-c', 'protocol.file.allow=always', 'submodule', 'add', sourcePath, 'deps/local-submodule',
  ]);
  await fixture.git(fixture.linkedWorktreePath, ['commit', '-am', 'Add local submodule']);
  await fixture.git(fixture.linkedWorktreePath, ['push', 'origin', 'feature/safe']);
  await fixture.write(
    fixture.linkedWorktreePath,
    'deps/local-submodule/README.md',
    'dirty submodule checkout\n',
  );
}
