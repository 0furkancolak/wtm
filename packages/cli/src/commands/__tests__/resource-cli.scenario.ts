import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStateStore } from '@wtm/core';
import { runCli } from '../../main';

const root = mkdtempSync(join(tmpdir(), 'wtm-resource-cli-'));
try {
  const workspaceRoot = join(root, 'workspace');
  const sandboxRoot = join(workspaceRoot, '.resources');
  const target = join(sandboxRoot, 'stale');
  const crashTarget = join(sandboxRoot, 'crash');
  const crashContainer = join(sandboxRoot, '.wtm-gc-crash-recovery');
  const crashQuarantine = join(crashContainer, 'object');
  const preparedTarget = join(sandboxRoot, 'prepared-before-container');
  const preparedContainerTarget = join(sandboxRoot, 'prepared-after-container');
  const preparedContainer = join(sandboxRoot, '.wtm-gc-prepared-after-container');
  const databasePath = join(root, 'state.db');
  mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 });
  chmodSync(workspaceRoot, 0o700);
  writeFileSync(target, 'data');
  writeFileSync(crashTarget, 'crash');
  writeFileSync(preparedTarget, 'prepared');
  writeFileSync(preparedContainerTarget, 'prepared-container');
  const sandboxStat = lstatSync(sandboxRoot);
  const targetStat = lstatSync(target);
  const crashStat = lstatSync(crashTarget);
  const preparedStat = lstatSync(preparedTarget);
  const preparedContainerTargetStat = lstatSync(preparedContainerTarget);
  const store = new SQLiteStateStore(databasePath);
  store.upsertWorkspace({ name: 'workspace', root: workspaceRoot, scope: 'local', configPath: null });
  store.upsertResourceSandbox({
    id: 'sandbox', root: sandboxRoot, generation: 'generation',
    dev: sandboxStat.dev, ino: sandboxStat.ino, uid: sandboxStat.uid,
  });
  store.registerResourceStorageObject({
    id: 'object', sandboxId: 'sandbox', path: target,
    dev: targetStat.dev, ino: targetStat.ino, uid: targetStat.uid, kind: 'file',
    state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 4, allocatedBytes: targetStat.blocks * 512,
  });
  store.registerResourceStorageObject({
    id: 'crash-object', sandboxId: 'sandbox', path: crashTarget,
    dev: crashStat.dev, ino: crashStat.ino, uid: crashStat.uid, kind: 'file',
    state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 5, allocatedBytes: crashStat.blocks * 512,
  });
  store.acquireResourceCleanupLease({
    storageObjectId: 'crash-object', sandboxId: 'sandbox', sandboxGeneration: 'generation', path: crashTarget,
    dev: crashStat.dev, ino: crashStat.ino, uid: crashStat.uid, kind: 'file', state: 'STALE', retention: 'ephemeral',
  }, 'crashed-lease', 1);
  mkdirSync(crashContainer, { mode: 0o700 });
  const crashContainerStat = lstatSync(crashContainer);
  renameSync(crashTarget, crashQuarantine);
  store.recordResourceGcJournal({
    operationId: 'crash-operation', storageObjectId: 'crash-object', phase: 'quarantined',
    originalPath: crashTarget, quarantinePath: crashQuarantine,
    dev: crashStat.dev, ino: crashStat.ino, uid: crashStat.uid,
    sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file',
    quarantineContainer: {
      path: crashContainer, dev: crashContainerStat.dev, ino: crashContainerStat.ino,
      uid: crashContainerStat.uid, mode: crashContainerStat.mode,
    },
  });
  for (const item of [
    { id: 'prepared-object', path: preparedTarget, stat: preparedStat },
    { id: 'prepared-container-object', path: preparedContainerTarget, stat: preparedContainerTargetStat },
  ]) {
    store.registerResourceStorageObject({
      id: item.id, sandboxId: 'sandbox', path: item.path,
      dev: item.stat.dev, ino: item.stat.ino, uid: item.stat.uid, kind: 'file',
      state: 'STALE', retention: 'ephemeral', owned: true,
      createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
      lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: item.stat.size,
      allocatedBytes: item.stat.blocks * 512,
    });
    store.acquireResourceCleanupLease({
      storageObjectId: item.id, sandboxId: 'sandbox', sandboxGeneration: 'generation', path: item.path,
      dev: item.stat.dev, ino: item.stat.ino, uid: item.stat.uid, kind: 'file', state: 'STALE', retention: 'ephemeral',
    }, `${item.id}-lease`, 1);
  }
  const preparedQuarantine = join(sandboxRoot, '.wtm-gc-prepared-before-container', 'object');
  store.recordResourceGcJournal({
    operationId: 'prepared-operation', storageObjectId: 'prepared-object', phase: 'prepared',
    originalPath: preparedTarget, quarantinePath: preparedQuarantine,
    dev: preparedStat.dev, ino: preparedStat.ino, uid: preparedStat.uid,
    sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file', quarantineContainer: null,
  });
  mkdirSync(preparedContainer, { mode: 0o700 });
  const preparedContainerStat = lstatSync(preparedContainer);
  store.recordResourceGcJournal({
    operationId: 'prepared-container-operation', storageObjectId: 'prepared-container-object', phase: 'prepared',
    originalPath: preparedContainerTarget, quarantinePath: join(preparedContainer, 'object'),
    dev: preparedContainerTargetStat.dev, ino: preparedContainerTargetStat.ino, uid: preparedContainerTargetStat.uid,
    sandboxId: 'sandbox', sandboxGeneration: 'generation', kind: 'file',
    quarantineContainer: {
      path: preparedContainer, dev: preparedContainerStat.dev, ino: preparedContainerStat.ino,
      uid: preparedContainerStat.uid, mode: preparedContainerStat.mode,
    },
  });
  const unrelatedRoot = join(root, 'unrelated');
  const unrelatedSandbox = join(unrelatedRoot, '.resources');
  const unrelatedTarget = join(unrelatedSandbox, 'stale');
  mkdirSync(unrelatedSandbox, { recursive: true, mode: 0o700 });
  chmodSync(unrelatedRoot, 0o700);
  writeFileSync(unrelatedTarget, 'unrelated');
  const unrelatedSandboxStat = lstatSync(unrelatedSandbox);
  const unrelatedTargetStat = lstatSync(unrelatedTarget);
  store.upsertResourceSandbox({
    id: 'unrelated-sandbox', root: unrelatedSandbox, generation: 'unrelated-generation',
    dev: unrelatedSandboxStat.dev, ino: unrelatedSandboxStat.ino, uid: unrelatedSandboxStat.uid,
  });
  store.upsertWorkspace({ name: 'unrelated', root: unrelatedRoot, scope: 'local', configPath: null });
  store.registerResourceStorageObject({
    id: 'unrelated-object', sandboxId: 'unrelated-sandbox', path: unrelatedTarget,
    dev: unrelatedTargetStat.dev, ino: unrelatedTargetStat.ino, uid: unrelatedTargetStat.uid, kind: 'file',
    state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 9, allocatedBytes: unrelatedTargetStat.blocks * 512,
  });
  const nestedRoot = join(workspaceRoot, 'nested');
  const nestedSandbox = join(nestedRoot, '.resources');
  const nestedTarget = join(nestedSandbox, 'stale');
  mkdirSync(nestedSandbox, { recursive: true, mode: 0o700 });
  chmodSync(nestedRoot, 0o700);
  writeFileSync(nestedTarget, 'nested');
  const nestedSandboxStat = lstatSync(nestedSandbox);
  const nestedTargetStat = lstatSync(nestedTarget);
  store.upsertWorkspace({ name: 'nested', root: nestedRoot, scope: 'local', configPath: null });
  store.upsertResourceSandbox({
    id: 'nested-sandbox', root: nestedSandbox, generation: 'nested-generation',
    dev: nestedSandboxStat.dev, ino: nestedSandboxStat.ino, uid: nestedSandboxStat.uid,
  });
  store.registerResourceStorageObject({
    id: 'nested-object', sandboxId: 'nested-sandbox', path: nestedTarget,
    dev: nestedTargetStat.dev, ino: nestedTargetStat.ino, uid: nestedTargetStat.uid, kind: 'file',
    state: 'STALE', retention: 'ephemeral', owned: true,
    createdAt: '2020-01-01T00:00:00.000Z', lastUsedAt: '2020-01-01T00:00:00.000Z',
    lastVerifiedAt: '2020-01-01T00:00:00.000Z', logicalBytes: 6, allocatedBytes: nestedTargetStat.blocks * 512,
  });
  store.close();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

  const run = async (argv: string[]) => {
    let output = '';
    await runCli(argv, { resourceDatabasePath: databasePath, cwd: workspaceRoot, stdout(value) { output += value; }, stderr() {} });
    return JSON.parse(output) as { ok: boolean; data: Record<string, unknown> };
  };
  const stateSnapshot = () => readdirSync(root).filter((name) => name === 'state.db').map((name) => {
    const stat = statSync(join(root, name));
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  const beforeReadOnly = stateSnapshot();
  const runFrom = async (argv: string[], cwd: string) => {
    let output = '';
    await runCli(argv, { resourceDatabasePath: databasePath, cwd, stdout(value) { output += value; }, stderr() {} });
    return JSON.parse(output) as { ok: boolean; data: Record<string, unknown> };
  };
  const parentDisk = await runFrom(['disk', '--json'], root);
  const parentGc = await runFrom(['gc', '--apply', '--json'], root);
  const siblingsSurvivedParentApply = existsSync(target) && existsSync(unrelatedTarget);
  const nestedDisk = await runFrom(['disk', '--json'], nestedRoot);
  const disk = await run(['disk', '--json']);
  const dry = await run(['gc', '--json']);
  const afterReadOnly = stateSnapshot();
  const survivedDryRun = existsSync(target);
  const apply = await run(['gc', '--apply', '--json']);
  const finalStore = new SQLiteStateStore(databasePath, { readonly: true });
  const preparedPhases = finalStore.listResourceGcJournal()
    .filter((entry) => entry.operationId.startsWith('prepared'))
    .map((entry) => entry.phase);
  finalStore.close();
  process.stdout.write(JSON.stringify({
    diskOk: disk.ok,
    diskOwned: (disk.data.owned as { objects: number }).objects,
    parentDiskOwned: (parentDisk.data.owned as { objects: number }).objects,
    parentGcPlanned: parentGc.data.planned,
    siblingsSurvivedParentApply,
    nestedDiskOwned: (nestedDisk.data.owned as { objects: number }).objects,
    dryOk: dry.ok,
    dryMode: dry.data.mode,
    survivedDryRun,
    readOnlyStateUnchanged: JSON.stringify(beforeReadOnly) === JSON.stringify(afterReadOnly),
    applyOk: apply.ok,
    applyMode: apply.data.mode,
    survivedApply: existsSync(target),
    recoveredCrashQuarantine: !existsSync(crashContainer),
    recoveredPreparedTargets: !existsSync(preparedTarget) && !existsSync(preparedContainerTarget),
    recoveredPreparedContainers: !existsSync(preparedContainer) && !existsSync(join(sandboxRoot, '.wtm-gc-prepared-before-container')),
    preparedPhases,
    unrelatedSurvivedApply: existsSync(unrelatedTarget),
    nestedSurvivedOuterApply: existsSync(nestedTarget),
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
