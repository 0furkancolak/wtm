import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeFileTrust } from './file-trust-fixture';

// Observe actual FileHandles in an isolated Node child. Retaining references makes a leak
// deterministic instead of depending on the GC warning timing that exposed it in native CI.
const originalOpen = fs.open;
const handles = new Set<Awaited<ReturnType<typeof fs.open>>>();
let openedHandles = 0;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  handles.add(handle);
  openedHandles += 1;
  handle.once('close', () => handles.delete(handle));
  return handle;
};
syncBuiltinESMExports();
const { authorizeResourcePath, createResourceGuard } = await import('../guard');
const mode = process.argv[2];
const root = await fs.mkdtemp(join(tmpdir(), 'wtm-guard-lifecycle-'));
const workspaceRoot = join(root, 'workspace');
const sandboxRoot = join(workspaceRoot, 'resources');
await fs.mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
const nested = join(sandboxRoot, 'nested');
await fs.mkdir(nested, { mode: 0o700 });
const target = join(nested, 'cache');
const reached = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let pause = false;
const options = {
  sandboxRoot, workspaceRoot, repositoryRoots: [workspaceRoot], fileTrust: createFakeFileTrust(),
  git: { async isTracked() { if (pause) { reached.resolve(); await release.promise; } return false; } },
};
let guard: Awaited<ReturnType<typeof createResourceGuard>> | undefined;
try {
  if (mode === 'production-gc') {
    await import('../../../../cli/src/commands/__tests__/resource-cli.scenario');
    assert.ok(openedHandles >= 2, 'production GC must actually acquire resource identity descriptors');
    assert.equal(handles.size, 0, 'production GC must release every sandbox and parent descriptor');
  } else if (mode === 'one-shot') {
    await authorizeResourcePath(options, target, 'write');
    assert.equal(handles.size, 0, 'one-shot authorization must not retain an inaccessible guard');
    await assert.rejects(authorizeResourcePath(options, workspaceRoot, 'delete'));
    assert.equal(handles.size, 0, 'rejected one-shot authorization must also release descriptors');
  } else {
    guard = await createResourceGuard(options);
    const token = await guard.authorize(target, 'write');
    await guard.revalidate(token);
    assert.ok(handles.size >= 2, 'real descriptors must hold both sandbox and parent identities');
    assert.equal(typeof guard.close, 'function', 'guard must expose explicit descriptor ownership disposal');
    if (mode === 'in-flight') {
      pause = true;
      const pending = guard.authorize(target, 'write');
      await reached.promise;
      let closed = false;
      const closing = guard.close().then(() => { closed = true; });
      await Promise.resolve();
      assert.equal(closed, false, 'close must wait for an in-flight authorization before releasing pins');
      await assert.rejects(guard.authorize(target, 'write'), { code: 'RESOURCE_PATH_DENIED' });
      release.resolve();
      await pending;
      await closing;
    } else await guard.close();
    assert.equal(handles.size, 0, 'all real inode descriptors must close');
    await guard.close();
    await assert.rejects(guard.authorize(target, 'write'), { code: 'RESOURCE_PATH_DENIED' });
    await assert.rejects(guard.revalidate(token), { code: 'RESOURCE_PATH_DENIED' });
    assert.equal(handles.size, 0, 'a disposed guard must not reacquire descriptors');
  }
} finally {
  release.resolve();
  if (typeof guard?.close === 'function') await guard.close();
  await Promise.allSettled([...handles].map((handle) => handle.close()));
  fs.open = originalOpen;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
}
