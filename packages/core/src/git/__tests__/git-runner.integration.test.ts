import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorktreeFixture } from '../../../../testkit/src/git-fixture';
import { GitCommandError, createGitEnvironment, listGitWorktrees, runGit } from '../git-runner';

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

describe('createGitEnvironment', () => {
  it('removes repository-routing variables without mutating or dropping unrelated environment', () => {
    const source = {
      PATH: '/usr/bin',
      WTM_SENTINEL: 'preserved',
      GIT_CONFIG_GLOBAL: '/tmp/global-config',
      GIT_DIR: '/tmp/wrong.git',
      GIT_WORK_TREE: '/tmp/wrong-tree',
      GIT_COMMON_DIR: '/tmp/common.git',
      GIT_INDEX_FILE: '/tmp/index',
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/alternate',
      GIT_NAMESPACE: 'wrong-namespace',
      GIT_SHALLOW_FILE: '/tmp/shallow',
      GIT_GRAFT_FILE: '/tmp/grafts',
      GIT_REPLACE_REF_BASE: 'refs/replace-test/',
      GIT_CEILING_DIRECTORIES: '/tmp',
      GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
      GIT_PREFIX: 'wrong-prefix',
      GIT_CONFIG_PARAMETERS: "'core.worktree'='/tmp/wrong-tree'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: '/tmp/wrong-tree',
    };

    const result = createGitEnvironment(source);

    expect(result).toEqual({
      PATH: '/usr/bin',
      WTM_SENTINEL: 'preserved',
      GIT_CONFIG_GLOBAL: '/tmp/global-config',
    });
    expect(source.GIT_DIR).toBe('/tmp/wrong.git');
    expect(source.WTM_SENTINEL).toBe('preserved');
  });
});

describe('runGit timeouts', () => {
  /**
   * A `git` on PATH that cannot make progress, standing in for the real ones that cannot: a lock
   * it will never win, a volume the process may not read, a privacy prompt no background agent can
   * answer.
   *
   * This used to be a one-millisecond timeout on a real `git worktree list`, on the reasoning that
   * no git reaches `exec` that fast. The first Linux CI run disproved it. On Linux the git
   * *finished* inside the millisecond, so the timer fired, `kill` landed on an already-exited
   * process, and `close` reported the natural exit -- `signal none` where the test demanded
   * `signal SIGTERM`. The behaviour under test was never exercised there, and on a loaded macOS
   * runner the same race could have gone the other way at any time; it had simply never been run
   * anywhere that lost it.
   *
   * `exec` matters: without it the shell stays alive holding the stdio pipes, so SIGTERM kills the
   * shell while `sleep` keeps the pipe open and `close` never fires.
   */
  async function stalledGitOnPath(): Promise<{ restore: () => Promise<void> }> {
    const directory = await mkdtemp(join(tmpdir(), 'wtm-stalled-git-'));
    const executable = join(directory, 'git');
    await writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    return {
      restore: async () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  it('kills a git that outlives its timeout instead of waiting on it forever', async () => {
    const fixture = await createGitWorktreeFixture();
    const stalled = await stalledGitOnPath();
    try {
      const startedAt = Date.now();
      const failure = await runGit(fixture.repoPath, ['worktree', 'list'], { timeoutMs: 50 })
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(GitCommandError);
      expect((failure as GitCommandError).timedOut).toBe(true);
      // The signal is the claim: this git could not have exited on its own inside thirty seconds,
      // so reporting SIGTERM is evidence that the timeout is what ended it.
      // Twenty-two of these a pass, none of them naming a repository, is the same as silence.
      expect((failure as GitCommandError).message)
        .toBe(`Git worktree list in ${fixture.repoPath} failed (signal SIGTERM): Timed out after 50ms`);
      // Far below the thirty seconds the child would have taken, and below the two-second
      // escalation to SIGKILL, so this also pins that SIGTERM alone was enough.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await stalled.restore();
      await fixture.cleanup();
    }
  });
});
