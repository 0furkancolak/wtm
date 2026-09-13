import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WtmConfig } from '../../config/schema';
import type { GitWorktreeRecord } from '../../git/worktree-parser';
import type { RepositoryRecord } from '../../state/store';
import { planFeatureCreation, resolveCommit, resolveFeatureMembers } from '../create-feature';

const repository = (id: string, mainRoot: string): RepositoryRecord => ({
  id, workspaceId: 'ws', commonGitDir: `${mainRoot}/.git`, mainRoot, remoteIdentity: null,
  createdAt: '2026-09-13T00:00:00.000Z', lastReconciledAt: null,
});
const worktree = (path: string, branch: string | null, head: string): GitWorktreeRecord => ({
  path, branch, head, detached: branch === null, bare: false, lockedReason: null, prunableReason: null,
});
const config = (repos?: WtmConfig['repos']): WtmConfig => ({ version: 1, ...(repos === undefined ? {} : { repos }) }) as WtmConfig;

const web = repository('id-2', '/ws/web');
const api = repository('id-1', '/ws/services/api');
const worker = repository('id-3', '/ws/worker');

describe('resolveFeatureMembers', () => {
  test('resolves [repos] names and directory names, deduplicated, in id order', () => {
    const resolution = resolveFeatureMembers({
      config: config({ backend: { path: 'services/api' } } as WtmConfig['repos']),
      workspaceRoot: '/ws', repositories: [web, api, worker], names: ['web', 'backend', 'web'],
    });
    expect(resolution).toEqual({ outcome: 'resolved', repositories: [api, web] });
  });

  test('a repository named by a [repos] entry is not also reachable by its directory name', () => {
    const resolution = resolveFeatureMembers({
      config: config({ backend: { path: 'services/api' } } as WtmConfig['repos']),
      workspaceRoot: '/ws', repositories: [web, api], names: ['api'],
    });
    expect(resolution.outcome).toBe('refused');
  });

  test('unknown and ambiguous names are refused together', () => {
    const twin = repository('id-4', '/ws/other/web');
    const resolution = resolveFeatureMembers({
      config: config(), workspaceRoot: '/ws', repositories: [web, twin, worker], names: ['web', 'nope'],
    });
    expect(resolution).toMatchObject({
      outcome: 'refused',
      error: { code: 'WTM_CONFIG_INVALID', context: { unknown: ['nope'], ambiguous: ['web'] } },
    });
  });
});

describe('planFeatureCreation', () => {
  const nothingExists = () => false;

  test('pins each new branch at its own main worktree HEAD', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', pathExists: nothingExists,
      members: [
        { repository: api, topology: [worktree('/ws/services/api', 'refs/heads/main', 'a'.repeat(40))], branchOid: null, fromOid: null },
        { repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: null, fromOid: null },
      ],
    });
    expect(decision).toMatchObject({
      outcome: 'plan',
      members: [
        { position: 0, startOid: 'a'.repeat(40), branchExisted: false, plan: { path: '/ws/api-feat-auth', createsBranch: true, startPoint: 'a'.repeat(40) } },
        { position: 1, startOid: 'b'.repeat(40), branchExisted: false, plan: { path: '/ws/web-feat-auth', createsBranch: true, startPoint: 'b'.repeat(40) } },
      ],
    });
  });

  test('an existing branch is checked out and its current OID recorded', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', pathExists: nothingExists,
      members: [{ repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: 'c'.repeat(40), fromOid: null }],
    });
    expect(decision).toMatchObject({ outcome: 'plan', members: [{ startOid: 'c'.repeat(40), branchExisted: true, plan: { createsBranch: false, startPoint: null } }] });
  });

  test('every member is planned, and every refusal is reported before anything is written', () => {
    const decision = planFeatureCreation({
      workspaceRoot: '/ws', branch: 'feat/auth', from: 'release',
      pathExists: (path) => path === '/ws/worker-feat-auth',
      members: [
        { repository: api, topology: [worktree('/ws/services/api', 'refs/heads/main', 'a'.repeat(40))], branchOid: null, fromOid: 'd'.repeat(40) },
        { repository: web, topology: [worktree('/ws/web', 'refs/heads/main', 'b'.repeat(40))], branchOid: null, fromOid: null },
        { repository: worker, topology: [worktree('/ws/worker', 'refs/heads/main', 'e'.repeat(40))], branchOid: null, fromOid: 'f'.repeat(40) },
      ],
    });
    expect(decision.outcome).toBe('refused');
    if (decision.outcome !== 'refused') return;
    expect(decision.errors.map((error) => [error.code, error.context?.['repository']])).toEqual([
      ['WTM_CONFIG_INVALID', '/ws/web'],
      ['WTM_WORKTREE_PATH_OCCUPIED', '/ws/worker'],
    ]);
  });
});

describe('resolveCommit', () => {
  test('answers an OID for a commit-ish and null for a name that is not one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wtm-resolve-commit-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'WTM Test');
      git('config', 'user.email', 'wtm-test@example.invalid');
      writeFileSync(join(root, 'README.md'), 'x\n');
      git('add', 'README.md');
      git('commit', '-m', 'x');
      const head = git('rev-parse', 'HEAD');
      expect([
        await resolveCommit(root, 'refs/heads/main'),
        await resolveCommit(root, 'refs/heads/absent'),
        await resolveCommit(root, '--help'),
      ]).toEqual([head, null, null]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
