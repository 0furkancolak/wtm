import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import { runProductionGcCommand } from '../resource-production';

const fileTrust: FileTrustPolicy = selectPlatformRuntime().fileTrust;

const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-gc-unrelated-')));
const workspaceRoot = join(root, 'workspace');
const sandboxRoot = join(workspaceRoot, 'resources');
const target = join(sandboxRoot, 'stale');
const databasePath = join(root, 'state.db');
// A repository some *other*, unrelated workspace registered whose directory has since been
// deleted or moved without `wtm forget` -- never created on disk here, so it is not a Git
// repository at all as far as this scenario is concerned. Round 25's audit finding: `wtm gc`
// used to fetch every registered repository/worktree on the machine, unscoped, to build the
// resource guard's protected-path list, so `git rev-parse` failing against this one aborted the
// whole command -- for the *local* workspace below, which has nothing to do with it.
let store: SQLiteStateStore | null = null;
try {
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await writeFile(target, 'preserved resource');
  const sandbox = await lstat(sandboxRoot);
  const object = await lstat(target);

  store = new SQLiteStateStore(databasePath);
  store.upsertWorkspace({ name: 'local', root: workspaceRoot, scope: 'local', configPath: null });
  store.upsertResourceSandbox({
    id: 'sandbox', root: sandboxRoot, generation: 'generation',
    dev: sandbox.dev, ino: sandbox.ino, uid: sandbox.uid,
  });
  store.registerResourceStorageObject({
    id: 'object', sandboxId: 'sandbox', path: target, dev: object.dev, ino: object.ino, uid: object.uid,
    kind: 'file', state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: object.size, allocatedBytes: object.blocks * 512,
  });

  const other = store.upsertWorkspace({
    name: 'other', root: join(root, 'other-workspace'), scope: 'local', configPath: null,
  });
  const otherRepoRoot = join(root, 'other-repo-gone');
  store.upsertRepository({
    workspaceId: other.id,
    commonGitDir: join(otherRepoRoot, '.git'),
    mainRoot: otherRepoRoot,
    remoteIdentity: null,
  });
  store.close();
  store = null;

  const result = await runProductionGcCommand({ databasePath, cwd: workspaceRoot, apply: false, fileTrust });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data?.mode, 'dry-run');
  assert.equal(result.data?.items[0]?.outcome, 'would-delete');
  console.log(JSON.stringify({ ok: true }));
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}
