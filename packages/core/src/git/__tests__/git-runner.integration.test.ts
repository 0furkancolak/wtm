import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('rejects with structured command evidence when Git fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-git-failure-'));
    try {
      await expect(listGitWorktrees(directory)).rejects.toMatchObject({
        name: 'GitCommandError',
        code: 'GIT_COMMAND_FAILED',
        argv: ['git', '-C', directory, 'worktree', 'list', '--porcelain', '-z'],
        exitCode: 128,
        signal: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
