import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { analyzeWorktree, type WorktreeContext } from '../worktree-analysis';
import { removeWorktreeGuardedWithHooks, type RemovalRuntimeCoordinator } from '../remove-worktree';

const mode = process.argv[2];
const fixture = await createGitSafetyFixture();
const originalLstat = fs.promises.lstat;
const external = join(fixture.root, 'external.txt');
const linkPath = join(fixture.linkedWorktreePath, 'file-link');
const context: WorktreeContext & { untrackedSymlinks?: 'ignore' | 'review' | 'block' } = {
  repoPath: fixture.repoPath, worktreePath: fixture.linkedWorktreePath, baseRef: 'refs/heads/main',
};
const symlinkCode = 'GIT_UNTRACKED_SYMLINKS';
const stages: string[] = [];

try {
  fs.writeFileSync(external, 'external content must survive');
  if (['default', 'ignore', 'review', 'block'].includes(mode!)) {
    if (mode !== 'default') context.untrackedSymlinks = mode as 'ignore' | 'review' | 'block';
    fs.symlinkSync(external, linkPath, 'file');
    const externalDirectory = join(fixture.root, 'external-directory');
    fs.mkdirSync(externalDirectory);
    fs.writeFileSync(join(externalDirectory, 'data'), 'directory target must survive');
    fs.symlinkSync(externalDirectory, join(fixture.linkedWorktreePath, 'directory-link'), 'dir');
    fs.symlinkSync(join(fixture.root, 'missing-target'), join(fixture.linkedWorktreePath, 'dangling-link'), 'file');
    await fixture.write(fixture.repoPath, '.git/info/exclude', '.ignored-link\nignored.data\n');
    fs.symlinkSync(external, join(fixture.linkedWorktreePath, '.ignored-link'), 'file');

    const analysis = await analyzeWorktree(context);
    assert.deepEqual(analysis.workingTree.classifications, ['clean']);
    assert.deepEqual(analysis.workingTree.paths.untracked, []);
    assert.deepEqual(analysis.workingTree.paths.ignored, []);
    assert.equal(analysis.safety.readiness, mode === 'review' ? 'REVIEW' : mode === 'block' ? 'BLOCKED' : 'SAFE');
    const messages = [...analysis.safety.warnings, ...analysis.safety.blockers];
    assert.equal(messages.length, mode === 'review' || mode === 'block' ? 1 : 0);
    if (messages.length > 0) {
      assert.equal(messages[0]?.code, symlinkCode);
      assert.equal(messages[0]?.severity, mode === 'review' ? 'warning' : 'error');
      assert.deepEqual(messages[0]?.context?.['paths'], ['dangling-link', 'directory-link', 'file-link']);
      assert.equal(messages[0]?.context?.['count'], 3);
      assert.equal(messages[0]?.context?.['policy'], mode);
    }

    await fixture.write(fixture.linkedWorktreePath, 'notes.txt', 'untracked content');
    await fixture.write(fixture.linkedWorktreePath, 'ignored.data', 'ignored content');
    const mixed = await analyzeWorktree(context);
    assert.deepEqual(mixed.workingTree.paths.untracked, ['notes.txt']);
    assert.deepEqual(mixed.workingTree.paths.ignored, ['ignored.data']);
    assert.deepEqual(mixed.safety.blockers.map(({ code }) => code).sort(),
      ['GIT_UNTRACKED', 'GIT_IGNORED_CONTENT', ...(mode === 'block' ? [symlinkCode] : [])].sort());
    assert.equal(fs.readFileSync(join(externalDirectory, 'data'), 'utf8'), 'directory target must survive');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  } else if (mode === 'invalid-policy') {
    for (const untrackedSymlinks of ['allow-all', null, 42]) {
      await assert.rejects(analyzeWorktree({ ...context, untrackedSymlinks } as unknown as WorktreeContext), {
        name: 'WorktreeAnalysisError', code: 'GIT_REPOSITORY_DEGRADED',
      });
    }
  } else if (mode?.startsWith('error-') || mode === 'missing-link') {
    context.untrackedSymlinks = mode === 'missing-link' ? 'block' : mode.slice('error-'.length) as 'ignore' | 'review' | 'block';
    fs.symlinkSync(external, linkPath, 'file');
    // Only the lstat failure is injected; Git emits the real untracked link pathname.
    fs.promises.lstat = (async (...args: Parameters<typeof originalLstat>) => {
      if (resolve(String(args[0])) === linkPath) throw Object.assign(new Error('fixture inspection failure'), {
        code: mode === 'missing-link' ? 'ENOENT' : 'EACCES',
      });
      return await originalLstat(...args);
    }) as typeof originalLstat;
    syncBuiltinESMExports();
    if (mode === 'missing-link') assert.deepEqual((await analyzeWorktree(context)).safety.blockers, []);
    else await assert.rejects(analyzeWorktree(context), { code: 'EACCES' });
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  } else if (mode === 'block-initial' || mode === 'block-after-cleanup') {
    context.untrackedSymlinks = 'block';
    context.repositoryId = 'repository-1'; context.worktreeId = 'worktree-1';
    if (mode === 'block-initial') fs.symlinkSync(external, linkPath, 'file');
    const coordinator: RemovalRuntimeCoordinator = {
      async reclaimablePaths() { stages.push('reclaimable'); return [linkPath]; },
      async stopManagedProcesses() { stages.push('stop'); return { stopped: 0 }; },
      async verifyManagedProcessesStopped() { stages.push('verify'); return { active: 0, cleanupOwed: 0 }; },
      async cleanupEphemeralResources() {
        stages.push('cleanup');
        if (mode === 'block-after-cleanup') fs.symlinkSync(external, linkPath, 'file');
        return { collected: 0, retained: [] };
      },
      async releaseEndpointLeases() { stages.push('release'); return { released: 0 }; },
      async reconcile() { stages.push('reconcile'); },
    };
    await assert.rejects(removeWorktreeGuardedWithHooks({ context, coordinator }, {}), (error: unknown) => {
      assert.equal((error as Error).name, 'WorktreeRemovalBlockedError');
      assert.deepEqual((error as { blockers: Array<{ code: string }> }).blockers.map(({ code }) => code), [symlinkCode]);
      return true;
    });
    assert.deepEqual(stages, mode === 'block-initial' ? [] : ['stop', 'verify', 'cleanup', 'release']);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
  } else if (mode === 'replace-link') {
    context.untrackedSymlinks = 'review';
    fs.symlinkSync(external, linkPath, 'file');
    await assert.rejects(removeWorktreeGuardedWithHooks({ context }, {
      afterInitialAnalysis(analysis) {
        assert.equal(analysis.safety.warnings[0]?.code, symlinkCode);
        fs.unlinkSync(linkPath);
        fs.writeFileSync(linkPath, 'new ordinary file must survive');
      },
    }), (error: unknown) => {
      assert.equal((error as Error).name, 'WorktreeRemovalBlockedError');
      assert.deepEqual((error as { blockers: Array<{ code: string }> }).blockers.map(({ code }) => code), ['GIT_UNTRACKED']);
      return true;
    });
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'new ordinary file must survive');
  } else if (mode === 'git-veto-ignore' || mode === 'git-veto-review') {
    context.untrackedSymlinks = mode === 'git-veto-ignore' ? 'ignore' : 'review';
    fs.symlinkSync(external, linkPath, 'file');
    let passedAnalysis = false;
    await assert.rejects(removeWorktreeGuardedWithHooks({ context }, {
      afterInitialAnalysis(analysis) { passedAnalysis = true; assert.deepEqual(analysis.safety.blockers, []); },
    }), { name: 'GitCommandError' });
    assert.equal(passedAnalysis, true);
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink(), 'No force or arbitrary symlink unlink may bypass Git');
  } else { throw new Error(`Unknown symlink policy mode: ${mode}`); }
  assert.equal(fs.readFileSync(external, 'utf8'), 'external content must survive');
  assert.ok(fs.statSync(fixture.linkedWorktreePath).isDirectory());
  console.log(JSON.stringify({ mode, verified: true }));
} finally {
  fs.promises.lstat = originalLstat;
  syncBuiltinESMExports();
  await fixture.cleanup();
}
