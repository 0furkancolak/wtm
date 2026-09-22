import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemMigrationAssets } from '../assets';
import { SQLiteStateStore } from '../sqlite-store';

// A real installed database that predates migrations 10-18 (repository operation leases, heavy
// jobs, heavy-job memory estimates, feature creations, CI watches, task overrides, checklist
// items, the dead resources-table drop) — the shape a contributor's disk actually had before
// upgrading past 2026-08. Populated through the store's own public API, the same way the real
// daemon would have written it, not hand-rolled INSERTs.
const root = await mkdtemp(join(tmpdir(), 'wtm-real-world-upgrade-'));
const path = join(root, 'state.db');
try {
  const oldMigrations = filesystemMigrationAssets.readMigrations().slice(0, 9);
  const old = new SQLiteStateStore(path, { migrationAssets: { readMigrations: () => oldMigrations } });
  let workspaceId: string;
  let repositoryId: string;
  let mainWorktreeId: string;
  let featureWorktreeId: string;
  try {
    const workspace = old.upsertWorkspace({ name: 'acme', root: '/home/dev/acme', scope: 'local', configPath: '/home/dev/acme/wtm.toml' });
    workspaceId = workspace.id;
    const repository = old.upsertRepository({
      workspaceId, commonGitDir: '/home/dev/acme/.git', mainRoot: '/home/dev/acme', remoteIdentity: 'github.com/acme/acme',
    });
    repositoryId = repository.id;

    const reconciled = old.reconcileWorktrees(repositoryId, [
      { path: '/home/dev/acme', head: 'a1b2c3d', branch: 'main', detached: false, bare: false, lockedReason: null, prunableReason: null },
      { path: '/home/dev/acme-feature-x', head: 'e4f5061', branch: 'feature/x', detached: false, bare: false, lockedReason: null, prunableReason: null },
    ]);
    const main = reconciled.discovered.find((worktree) => worktree.path === '/home/dev/acme');
    const feature = reconciled.discovered.find((worktree) => worktree.path === '/home/dev/acme-feature-x');
    assert.ok(main !== undefined && feature !== undefined, 'both worktrees must be discovered');
    mainWorktreeId = main.id;
    featureWorktreeId = feature.id;

    old.allocateEndpoint({
      worktreeId: featureWorktreeId, name: 'dev', protocol: 'tcp', host: '127.0.0.1', portRange: { min: 4000, max: 4010 }, preferredPort: 4000,
    });
    old.createManagedProcess({
      worktreeId: featureWorktreeId, taskName: 'dev', pid: 5150, pgid: 5150, processStartTime: 'Mon Aug 24 09:00:00 2026',
      commandFingerprint: 'npm run dev', state: 'RUNNING', startedAt: '2026-08-24T09:00:00.000Z', stoppedAt: null,
      stdoutPath: '/home/dev/acme-feature-x/.wtm/dev.stdout.log', stderrPath: '/home/dev/acme-feature-x/.wtm/dev.stderr.log',
    });
  } finally {
    old.close();
  }

  // The upgrade a real user gets: open the same file with no override, so every migration
  // asset the current build ships (all 18) runs against it in order.
  const upgraded = new SQLiteStateStore(path);
  try {
    const workspaces = upgraded.upsertWorkspace({ name: 'acme', root: '/home/dev/acme', scope: 'local', configPath: '/home/dev/acme/wtm.toml' });
    assert.equal(workspaces.id, workspaceId, 'upgrade must not mint a new workspace row for the same root');

    const worktrees = upgraded.listWorktrees(repositoryId);
    assert.equal(worktrees.length, 2, 'both pre-upgrade worktrees must survive');
    const main = worktrees.find((worktree) => worktree.id === mainWorktreeId);
    const feature = worktrees.find((worktree) => worktree.id === featureWorktreeId);
    assert.equal(main?.branch, 'main');
    assert.equal(feature?.branch, 'feature/x');
    assert.equal(feature?.headOid, 'e4f5061');

    const leases = upgraded.listEndpointLeases({ worktreeIds: [featureWorktreeId] });
    assert.equal(leases.length, 1);
    assert.equal(leases[0]?.port, 4000);
    assert.equal(leases[0]?.state, 'ACTIVE');

    const process = upgraded.findActiveManagedProcess(featureWorktreeId, 'dev');
    assert.equal(process?.pid, 5150);
    assert.equal(process?.state, 'RUNNING');

    // Every feature migrations 10-18 added must now be usable against this upgraded database,
    // not merely present as an empty table.
    const lease = upgraded.acquireRepositoryOperationLease(
      { repositoryId, operation: 'remove', token: 'upgrade-check', pid: 1, processStartTime: 'x', hostId: 'host-a', ttlMs: 60_000 },
      '2026-09-22T00:00:00.000Z',
    );
    assert.equal(lease.outcome, 'acquired');
    upgraded.releaseRepositoryOperationLease({ repositoryId, operation: 'remove' }, 'upgrade-check');

    const { job } = upgraded.jobs.enqueue({
      scope: 'host:user', workspaceId, repositoryId, worktreeId: featureWorktreeId, worktreePath: '/home/dev/acme-feature-x',
      taskName: 'build', idempotencyKey: 'upgrade-build', commandFingerprint: 'npm run build', sourceFingerprint: 'src-hash',
      timeoutMs: 60_000, now: '2026-09-22T00:00:00.000Z',
    });
    assert.equal(job.memoryEstimateBytes, null, 'the memory-estimate column migration 013 added must be readable on a fresh row too');

    const feature0 = upgraded.upsertFeature(workspaceId, 'feature/x');
    assert.equal(feature0.branch, 'feature/x');

    const overrideRecord = upgraded.taskOverrides.set({
      worktreeId: featureWorktreeId, taskName: 'dev', task: { run: 'npm run dev:override', shell: true }, now: '2026-09-22T00:00:00.000Z',
    });
    assert.equal(overrideRecord.task.run, 'npm run dev:override');

    const checklistItems = upgraded.checklist.set(featureWorktreeId, ['ship it'], '2026-09-22T00:00:00.000Z');
    assert.equal(checklistItems.length, 1);
    assert.equal(checklistItems[0]?.text, 'ship it');

    console.log(JSON.stringify({
      workspacePreserved: true,
      worktreesPreserved: worktrees.length === 2,
      leasePreserved: leases[0]?.port === 4000,
      processPreserved: process?.pid === 5150,
      newSchemaUsable: true,
    }));
  } finally {
    upgraded.close();
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
