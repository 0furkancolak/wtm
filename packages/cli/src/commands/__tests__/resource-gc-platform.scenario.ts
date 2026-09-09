import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { createWindowsFileTrustPolicy } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import { runProductionGcCommand } from '../resource-production';

const mode = process.argv[2];
assert.ok(['guard-deny', 'dry-run', 'apply', 'recovery', 'recovery-deny'].includes(mode ?? ''));
const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-gc-platform-')));
const workspaceRoot = join(root, 'workspace');
const sandboxRoot = join(workspaceRoot, 'resources');
const target = join(sandboxRoot, 'stale');
const container = join(sandboxRoot, '.wtm-gc-recovery');
const quarantine = join(container, 'object');
const databasePath = join(root, 'state.db');
let store: SQLiteStateStore | null = null;
try {
  await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  // ACL trust deliberately differs from the POSIX mode fallback. This is a wiring fixture,
  // not evidence that these fake ACL entries describe a native Windows filesystem.
  if (mode !== 'guard-deny' && mode !== 'recovery-deny') await chmod(sandboxRoot, 0o777);
  await writeFile(target, 'preserved resource');
  const sandbox = await lstat(sandboxRoot);
  const object = await lstat(target);
  store = new SQLiteStateStore(databasePath);
  store.upsertWorkspace({ name: 'fixture', root: workspaceRoot, scope: 'local', configPath: null });
  store.upsertResourceSandbox({ id: 'sandbox', root: sandboxRoot, generation: 'generation', dev: sandbox.dev, ino: sandbox.ino, uid: sandbox.uid });
  store.registerResourceStorageObject({
    id: 'object', sandboxId: 'sandbox', path: target, dev: object.dev, ino: object.ino, uid: object.uid,
    kind: 'file', state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: object.size, allocatedBytes: object.blocks * 512,
  });
  const recovery = mode === 'recovery' || mode === 'recovery-deny';
  if (recovery) {
    await mkdir(container, { mode: 0o700 });
    if (mode === 'recovery') await chmod(container, 0o777);
    const containerStat = await lstat(container);
    store.acquireResourceCleanupLease({
      storageObjectId: 'object', sandboxId: 'sandbox', sandboxGeneration: 'generation', path: target,
      dev: object.dev, ino: object.ino, uid: object.uid, kind: 'file', state: 'STALE', retention: 'ephemeral',
    }, 'abandoned-lease', 1);
    await rename(target, quarantine);
    store.recordResourceGcJournal({
      operationId: 'recover-object', storageObjectId: 'object', phase: 'quarantined',
      originalPath: target, quarantinePath: quarantine, dev: object.dev, ino: object.ino, uid: object.uid,
      sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file',
      quarantineContainer: { path: container, dev: containerStat.dev, ino: containerStat.ino, uid: containerStat.uid, mode: containerStat.mode },
    });
  }
  store.close();
  store = null;

  const ownerSid = 'S-1-5-21-100-200-300-400';
  const foreignSid = 'S-1-5-21-100-200-300-999';
  const aclReads: string[] = [];
  const writeChecks: Array<{ path: string; mask: number }> = [];
  const policy = createWindowsFileTrustPolicy({
    currentUserSid: async () => ownerSid,
    readAcl: async (path) => {
      aclReads.push(path);
      const rel = relative(root, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
      const foreignRights = mode === 'guard-deny' && path === sandboxRoot ? 'Modify'
        : mode === 'recovery-deny' && path === container ? 'ReadAndExecute' : null;
      return {
        ownerSid,
        accessRules: [
          { identitySid: ownerSid, accessControlType: 'Allow' as const, fileSystemRights: 'FullControl' },
          ...(foreignRights === null ? [] : [{ identitySid: foreignSid, accessControlType: 'Allow' as const, fileSystemRights: foreignRights }]),
        ],
      };
    },
  });
  let identityChecks = 0;
  const fileTrust: FileTrustPolicy = {
    ...policy,
    currentIdentityAvailable() { identityChecks += 1; return policy.currentIdentityAvailable(); },
    async isWritableOnlyByOwner(stat, path, mask) {
      writeChecks.push({ path, mask });
      return await policy.isWritableOnlyByOwner(stat, path, mask);
    },
  };
  const result = await runProductionGcCommand({ databasePath, cwd: workspaceRoot, apply: mode !== 'dry-run', fileTrust });
  assert.ok(identityChecks > 0, 'the real resource guard must use the selected policy');
  assert.ok(aclReads.includes(sandboxRoot), 'sandbox ownership must reach the selected ACL reader');
  if (mode === 'guard-deny') {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.data, null);
    assert.equal(result.errors[0]?.code, 'RESOURCE_PATH_DENIED');
    assert.equal(await readFile(target, 'utf8'), 'preserved resource');
  } else if (mode === 'recovery-deny') {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(writeChecks.some((check) => check.path === container && check.mask === 0o077), 'recovery must preserve its stricter selected-policy access check');
    assert.equal(await readFile(quarantine, 'utf8'), 'preserved resource');
    store = new SQLiteStateStore(databasePath, { readonly: true });
    assert.notEqual(store.listResourceGcJournal()[0]?.phase, 'finalized');
  } else {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data?.mode, mode === 'dry-run' ? 'dry-run' : 'apply');
    if (mode === 'dry-run') {
      assert.equal(await readFile(target, 'utf8'), 'preserved resource');
      assert.equal(result.data?.items[0]?.outcome, 'would-delete');
    } else {
      assert.ok(writeChecks.some((check) => check.mask === 0o077), 'apply and recovery must retain selected-policy quarantine access checks');
      await assert.rejects(lstat(target), { code: 'ENOENT' });
      if (recovery) await assert.rejects(lstat(container), { code: 'ENOENT' });
      store = new SQLiteStateStore(databasePath, { readonly: true });
      assert.ok(store.listResourceGcJournal().some((entry) => entry.phase === 'finalized'));
    }
  }
  console.log(JSON.stringify({ mode, policyVerified: true }));
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
}
