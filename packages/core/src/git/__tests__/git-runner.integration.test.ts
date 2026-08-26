import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitWorktreeFixture } from '../../../../testkit/src/git-fixture';
import { createGitEnvironment, listGitWorktrees } from '../git-runner';

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
