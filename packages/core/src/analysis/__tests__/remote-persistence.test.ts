import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { GitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../../testkit/src/git-fixture';
import { GitCommandError } from '../../git/git-runner';
import { refreshRemoteTrackingRefs } from '../remote-persistence';

const fixtures: GitSafetyFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('refreshRemoteTrackingRefs', () => {
  test('fetches the remote an allowed pattern names and prunes its deleted branches', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.remotePath, ['branch', '-D', 'feature/safe']);

    const result = await refreshRemoteTrackingRefs(fixture.repoPath);

    expect(result.remotes).toEqual(['origin']);
    expect(new Date(result.refreshedAt).toISOString()).toBe(result.refreshedAt);
    const refs = await trackingRefs(fixture);
    expect(refs).toContain('refs/remotes/origin/main');
    expect(refs).not.toContain('refs/remotes/origin/feature/safe');
  });

  test('fetches nothing when no configured remote matches the allowed patterns', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.remotePath, ['branch', '-D', 'feature/safe']);

    const result = await refreshRemoteTrackingRefs(fixture.repoPath, ['refs/remotes/upstream/*']);

    expect(result.remotes).toEqual([]);
    // The stale tracking ref surviving is the proof that no remote was fetched: a fetch of
    // `origin` would have pruned it.
    expect(await trackingRefs(fixture)).toEqual([
      'refs/remotes/origin/feature/safe',
      'refs/remotes/origin/main',
    ]);

  });

  test('treats a wildcard remote segment as every configured remote', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.root, ['init', '--bare', '--initial-branch=main', 'mirror.git']);
    await fixture.git(fixture.repoPath, ['remote', 'add', 'mirror', join(fixture.root, 'mirror.git')]);

    const result = await refreshRemoteTrackingRefs(fixture.repoPath, ['refs/remotes/*']);

    expect(result.remotes).toEqual(['mirror', 'origin']);
  });

  test('fails closed with GIT_COMMAND_FAILED when a fetch fails', async () => {
    const fixture = await createFixture();
    await fixture.git(fixture.repoPath, [
      'remote', 'set-url', 'origin', join(fixture.root, 'gone.git'),
    ]);

    const failure = await refreshRemoteTrackingRefs(fixture.repoPath).then(
      (result) => result,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(GitCommandError);
    expect((failure as GitCommandError).code).toBe('GIT_COMMAND_FAILED');
  });

  test('rejects a remote name that reads as a git option before any git process runs', async () => {
    const fixture = await createFixture();
    // A path that is not a repository: any git this call spawned would fail with a
    // GitCommandError, so a TypeError proves the name was rejected before the spawn.
    const missingRepository = join(fixture.root, 'not-a-repository');

    const rejection = refreshRemoteTrackingRefs(missingRepository, ['refs/remotes/-oops/*']);

    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('-oops');
  });
});

async function createFixture(): Promise<GitSafetyFixture> {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  return fixture;
}

async function trackingRefs(fixture: GitSafetyFixture): Promise<string[]> {
  const result = await fixture.git(fixture.repoPath, [
    'for-each-ref', '--format=%(refname)', 'refs/remotes',
  ]);
  return result.stdout.split('\n').filter((line) => line.length > 0);
}
