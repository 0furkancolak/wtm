import { describe, expect, it } from 'bun:test';
import { createGitWorktreeFixture } from '../../../../testkit/src/git-fixture';
import { listGitWorktrees } from '../git-runner';

describe('listGitWorktrees', () => {
  it('reads normal, linked locked, and detached worktrees from Git porcelain', async () => {
    const fixture = await createGitWorktreeFixture();

    try {
      await expect(listGitWorktrees(fixture.repoPath)).resolves.toEqual([
        {
          path: fixture.repoPath,
          head: fixture.head,
          branch: 'refs/heads/main',
          detached: false,
          bare: false,
          lockedReason: null,
          prunableReason: null,
        },
        {
          path: fixture.detachedWorktreePath,
          head: fixture.head,
          branch: null,
          detached: true,
          bare: false,
          lockedReason: null,
          prunableReason: null,
        },
        {
          path: fixture.linkedWorktreePath,
          head: fixture.head,
          branch: 'refs/heads/feature/linked',
          detached: false,
          bare: false,
          lockedReason: 'integration lock',
          prunableReason: null,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
