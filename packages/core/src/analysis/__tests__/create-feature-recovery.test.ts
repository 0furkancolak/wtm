import { describe, expect, test } from 'bun:test';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import type { FeatureCreationMemberRecord, FeatureCreationPhase } from '../../state/store';
import { classifyMemberRecovery, type MemberRecoveryInput } from '../create-feature-recovery';

const start = 'a'.repeat(40);
const moved = 'b'.repeat(40);
const path = '/ws/web-feat-auth';

const member = (phase: FeatureCreationPhase, branchExisted = false): FeatureCreationMemberRecord => ({
  creationId: 'c', repositoryId: 'r', repositoryMainRoot: '/ws/web', position: 0, worktreePath: path,
  branchExisted, startOid: start, phase, lastErrorCode: null, updatedAt: '2026-09-13T00:00:00.000Z',
});
const record = (
  at: string, branch: string | null, prunableReason: string | null = null, head: string = start,
): GitWorktreeRecord => ({
  path: at, head, branch, detached: branch === null, bare: false, lockedReason: null, prunableReason,
});
const main = record('/ws/web', 'refs/heads/main');
const input = (overrides: Partial<MemberRecoveryInput>): MemberRecoveryInput => ({
  member: member('APPLYING'), branch: 'feat/auth', repositoryRegistered: true,
  topology: [main], branchOid: null, pathExists: false, ...overrides,
});

describe('classifyMemberRecovery', () => {
  const cases: Array<[string, MemberRecoveryInput, unknown]> = [
    ['a forgotten repository is refused, by name', input({ repositoryRegistered: false }),
      { action: 'refuse', error: { code: 'WTM_CONFIG_INVALID', context: { repository: '/ws/web' } } }],
    ['a registered member is skipped', input({ member: member('REGISTERED') }), { action: 'skip' }],
    ['a finished member is skipped even if its repository was since forgotten',
      input({ member: member('REGISTERED'), repositoryRegistered: false }), { action: 'skip' }],
    ['a worktree already on the branch at the path was applied, whatever the journal says',
      input({ topology: [main, record(path, 'refs/heads/feat/auth')], pathExists: true }),
      { action: 'mark-applied', worktree: { path, branch: 'refs/heads/feat/auth' } }],
    ['a worktree on the branch at the path counts as applied even if its HEAD moved past the start commit',
      input({ topology: [main, record(path, 'refs/heads/feat/auth', null, moved)], pathExists: true }),
      { action: 'mark-applied', worktree: { path, head: moved } }],
    ['a stale Git entry at the path is refused with git worktree prune',
      input({ topology: [main, record(path, 'refs/heads/feat/auth', 'gitdir file points to non-existent location')] }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED', remediation: [{ kind: 'command-suggestion', argv: ['git', '-C', '/ws/web', 'worktree', 'prune'] }] } }],
    ['a worktree on another branch at the path is refused',
      input({ topology: [main, record(path, 'refs/heads/other')], pathExists: true }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED' } }],
    ['the branch checked out elsewhere is refused',
      input({ topology: [main, record('/elsewhere', 'refs/heads/feat/auth')], branchOid: start }),
      { action: 'refuse', error: { code: 'GIT_BRANCH_IN_USE', context: { worktreePath: '/elsewhere' } } }],
    ['something at the path that is not a worktree is refused', input({ pathExists: true }),
      { action: 'refuse', error: { code: 'WTM_WORKTREE_PATH_OCCUPIED' } }],
    ['nothing written yet: the branch is created at the pinned commit', input({}),
      { action: 'apply', plan: { path, branch: 'feat/auth', branchRef: 'refs/heads/feat/auth', createsBranch: true, startPoint: start } }],
    ['an applied member whose worktree is gone converges again', input({ member: member('APPLIED') }),
      { action: 'apply', plan: { createsBranch: true, startPoint: start } }],
    ['a branch this creation made before worktree add failed is checked out', input({ branchOid: start }),
      { action: 'apply', plan: { createsBranch: false, startPoint: null } }],
    ['a branch that existed before the creation is checked out even if it moved',
      input({ member: member('PLANNED', true), branchOid: moved }),
      { action: 'apply', plan: { createsBranch: false, startPoint: null } }],
    ['a branch this creation did not make, at another commit, is refused', input({ branchOid: moved }),
      { action: 'refuse', error: { code: 'GIT_BRANCH_IN_USE', context: { branchOid: moved, startOid: start } } }],
  ];

  for (const [name, given, expected] of cases) {
    test(name, () => {
      expect(classifyMemberRecovery(given)).toMatchObject(expected as object);
    });
  }
});
