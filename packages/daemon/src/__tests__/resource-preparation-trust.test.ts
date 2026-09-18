import { afterEach, describe, expect, test } from 'bun:test';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { GitSafetyFixture } from '../../../testkit/src/git-fixture';
import { createGitSafetyFixture } from '../../../testkit/src/git-fixture';
import { prepareRuntimeResources, type WorktreeRuntime } from '../task-resolution';

/**
 * `prepareRuntimeResources` authorizes against the policy it is given, not against whichever one
 * `@wtm/core` falls back to.
 *
 * This covers the daemon half of the win32 resource defect. The CLI half has its own case in
 * `cli/src/__tests__/remove-runtime.test.ts`; this path is the other direction of the same core
 * call -- `prepareResources` creating what `cleanupWorktreeEphemeralResources` later deletes --
 * and it reaches core through a different composition root (`ProductionRuntimeResolver` and
 * `LifecycleEventDispatcher`, both in `runtime-factory.ts`).
 *
 * Neither assertion below depends on which platform is running it. A refusing policy has to be
 * consulted wherever the test runs; the host's own policy has to let the daemon prepare an
 * ordinary worktree wherever the test runs. That is the whole property, and it is exactly the one
 * that was false on Windows: the fallback answered every directory "group- or world-writable",
 * because Node synthesises a Windows directory's `mode` as `0o777`.
 *
 * What is deliberately *not* asserted here is which policy the two-argument form defaults to. On a
 * POSIX host `@wtm/core`'s fallback and `@wtm/platform`'s `posixFileTrustPolicy` are the same three
 * comparisons, so no behavioural assertion could tell them apart and any such test would pass on
 * revert. That the default is the host's is pinned where it is observable instead: by
 * `platform/src/__tests__/select.test.ts`, and by `runtime-factory.ts` now requiring the policy as
 * a constructor argument rather than defaulting it.
 */

const fixtures: GitSafetyFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

/** Everything `prepareRuntimeResources` reads, and nothing else it would ignore. */
function runtimeFor(worktreeRoot: string, workspaceRoot: string): WorktreeRuntime {
  const at = '2026-09-18T00:00:00.000Z';
  return {
    registration: {
      workspace: {
        id: 'workspace', name: 'preparation', root: workspaceRoot, scope: 'local',
        configPath: join(workspaceRoot, 'wtm.toml'), createdAt: at, lastSeenAt: at,
      },
      repository: {
        id: 'repository', workspaceId: 'workspace', commonGitDir: join(worktreeRoot, '.git'),
        mainRoot: worktreeRoot, remoteIdentity: null, createdAt: at, lastReconciledAt: null,
      },
      worktree: {
        id: 'worktree', repositoryId: 'repository', numericId: 1, path: worktreeRoot,
        branch: 'refs/heads/feature', headOid: null, isMain: false, isLocked: false,
        state: 'READY', createdAt: at, lastSeenAt: at, lastRuntimeAt: null,
      },
    },
    config: {
      version: 1,
      resources: {
        data: { path: '{worktree.root}/wtm-prepared', policy: 'ephemeral' },
      },
    },
    context: { worktree: { root: worktreeRoot } },
    automaticEnvironment: {},
    endpoints: { ports: {}, env: {}, origins: [], leases: [] },
    provenance: new Map(),
  };
}

/** What a Windows ACL policy answers for a directory this user owns: mode bits go unread. */
const aclShapedPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser: async () => true,
  isWritableOnlyByOwner: async () => true,
  isNotSharedByHardLink: () => true,
  currentIdentityAvailable: () => true,
};

/** A policy that refuses for a reason nothing about the filesystem can produce on its own. */
const refusingPolicy: FileTrustPolicy = {
  isOwnedByCurrentUser: async () => true,
  isWritableOnlyByOwner: async () => false,
  isNotSharedByHardLink: () => true,
  currentIdentityAvailable: () => true,
};

async function prepareWith(fileTrust: FileTrustPolicy | undefined) {
  const fixture = await createGitSafetyFixture();
  fixtures.push(fixture);
  const worktreeRoot = fixture.linkedWorktreePath;
  const runtime = runtimeFor(worktreeRoot, fixture.root);
  const prepared = await prepareRuntimeResources(runtime, fileTrust);
  const created = await lstat(join(worktreeRoot, 'wtm-prepared'))
    .then((entry) => entry.isDirectory(), () => false);
  return { prepared: prepared[0], created, worktreeRoot };
}

describe('daemon resource preparation', () => {
  test('creates the declared resource under the policy the composition root selected', async () => {
    const { prepared, created } = await prepareWith(aclShapedPolicy);

    expect(prepared?.state).toBe('ready');
    expect(created).toBe(true);
  });

  test('refuses through the injected policy rather than core\'s own fallback', async () => {
    const { prepared, created } = await prepareWith(refusingPolicy);

    expect(prepared?.state).toBe('degraded');
    expect(prepared?.detail).toContain('group- or world-writable');
    expect(created).toBe(false);
  });
});
