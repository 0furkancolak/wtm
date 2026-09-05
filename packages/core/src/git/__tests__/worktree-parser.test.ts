import { describe, expect, it } from 'bun:test';
import { parseGitWorktreePorcelain, toNativeGitPath } from '../worktree-parser';

const encodePorcelain = (records: string[][]): Uint8Array =>
  new TextEncoder().encode(records.flatMap((record) => [...record, '']).join('\0'));

describe('parseGitWorktreePorcelain', () => {
  it('parses NUL-delimited normal, detached, locked, bare, and prunable worktrees', () => {
    const output = encodePorcelain([
      [
        'worktree /repos/main',
        'HEAD 0123456789abcdef0123456789abcdef01234567',
        'branch refs/heads/main',
      ],
      [
        'worktree /repos/detached',
        'HEAD 89abcdef0123456789abcdef0123456789abcdef',
        'detached',
      ],
      [
        'worktree /repos/locked',
        'HEAD 0123456789abcdef0123456789abcdef01234567',
        'branch refs/heads/feature/locked',
        'locked deployment in progress',
      ],
      [
        'worktree /repos/bare',
        'bare',
      ],
      [
        'worktree /repos/prunable\nwith-newline',
        'HEAD 89abcdef0123456789abcdef0123456789abcdef',
        'prunable gitdir file points to non-existent location',
      ],
    ]);

    expect(parseGitWorktreePorcelain(output)).toEqual([
      {
        path: toNativeGitPath('/repos/main'),
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'refs/heads/main',
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: null,
      },
      {
        path: toNativeGitPath('/repos/detached'),
        head: '89abcdef0123456789abcdef0123456789abcdef',
        branch: null,
        detached: true,
        bare: false,
        lockedReason: null,
        prunableReason: null,
      },
      {
        path: toNativeGitPath('/repos/locked'),
        head: '0123456789abcdef0123456789abcdef01234567',
        branch: 'refs/heads/feature/locked',
        detached: false,
        bare: false,
        lockedReason: 'deployment in progress',
        prunableReason: null,
      },
      {
        path: toNativeGitPath('/repos/bare'),
        head: null,
        branch: null,
        detached: false,
        bare: true,
        lockedReason: null,
        prunableReason: null,
      },
      {
        path: toNativeGitPath('/repos/prunable\nwith-newline'),
        head: '89abcdef0123456789abcdef0123456789abcdef',
        branch: null,
        detached: false,
        bare: false,
        lockedReason: null,
        prunableReason: 'gitdir file points to non-existent location',
      },
    ]);
  });
});
