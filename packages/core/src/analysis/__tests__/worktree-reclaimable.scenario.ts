import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureWorktreeReclaimable } from '../worktree-reclaimable';

const mode = process.argv[2];
// Use the same canonicalization primitive as the production walker (Windows aliases differ).
const parent = await fs.promises.realpath(fs.mkdtempSync(join(tmpdir(), 'wtm-reclaimable-')));
const root = join(parent, 'worktree');
const outside = join(parent, 'outside');
const original = { lstat: fs.promises.lstat, opendir: fs.promises.opendir };
const preserved = Buffer.from('source file that must remain unchanged');
let outsideReads = 0;
let injected = 0;
try {
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'secret'), 'must remain external');
  fs.writeFileSync(join(root, 'source'), preserved);
  const excludedPaths: string[] = [];
  let maxEntries = 20_000;
  let maxDurationMs = 5_000;
  let signal: AbortSignal | undefined;
  let expectedBytes = fs.lstatSync(join(root, 'source')).blocks * 512;
  let targetRoot = root;

  if (mode === 'accounting') {
    fs.mkdirSync(join(root, 'nested'));
    fs.writeFileSync(join(root, 'nested', 'another'), 'another owned file');
    expectedBytes += fs.lstatSync(join(root, 'nested', 'another')).blocks * 512;
    fs.mkdirSync(join(root, '.git'));
    fs.writeFileSync(join(root, '.git', 'objects'), 'shared administrative evidence');
    for (const name of ['shared', 'native-cache', 'external', 'ignore']) {
      const path = join(root, name);
      fs.mkdirSync(path);
      fs.writeFileSync(join(path, 'data'), 'retained data');
      excludedPaths.push(path);
    }
    fs.writeFileSync(join(root, 'linked-one'), 'two links in the same tree');
    fs.linkSync(join(root, 'linked-one'), join(root, 'linked-two'));
    fs.linkSync(join(outside, 'secret'), join(root, 'external-hardlink'));
    fs.symlinkSync(outside, join(root, 'external-link'), 'dir');
  } else if (mode === 'sparse') {
    const fd = fs.openSync(join(root, 'sparse'), 'w');
    try { fs.ftruncateSync(fd, 50 * 1024 * 1024); } finally { fs.closeSync(fd); }
    expectedBytes += fs.lstatSync(join(root, 'sparse')).blocks * 512;
  } else if (mode === 'missing') {
    targetRoot = join(parent, 'missing');
  } else if (mode === 'root-symlink') {
    targetRoot = join(parent, 'root-link');
    fs.symlinkSync(root, targetRoot, 'dir');
  } else if (mode === 'entry-budget') {
    maxEntries = 1;
    fs.writeFileSync(join(root, 'second'), 'second');
  } else if (mode === 'time-budget') {
    maxDurationMs = 0;
  } else if (mode === 'aborted') {
    const controller = new AbortController();
    controller.abort();
    signal = controller.signal;
  } else if (mode === 'unreadable') {
    fs.promises.opendir = (async (...args: Parameters<typeof original.opendir>) => {
      if (String(args[0]) === root) { injected++; throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }
      return await original.opendir(...args);
    }) as typeof original.opendir;
  } else if (mode === 'allocation-unavailable' || mode === 'changed-file') {
    let sourceReads = 0;
    fs.promises.lstat = (async (...args: Parameters<typeof original.lstat>) => {
      const stat = await original.lstat(...args);
      if (String(args[0]) === join(root, 'source')) {
        sourceReads += 1;
        injected++;
        if (mode === 'allocation-unavailable') Object.defineProperty(stat, 'blocks', { value: -1n });
        else if (sourceReads > 1) Object.defineProperty(stat, 'size', { value: BigInt(preserved.length + 1) });
      }
      return stat;
    }) as typeof original.lstat;
  } else if (mode === 'directory-swap') {
    const nested = join(root, 'nested');
    const moved = join(parent, 'moved');
    fs.mkdirSync(nested);
    fs.writeFileSync(join(nested, 'original'), 'original nested source');
    fs.promises.opendir = (async (...args: Parameters<typeof original.opendir>) => {
      if (String(args[0]) !== nested) return await original.opendir(...args);
      injected++;
      fs.renameSync(nested, moved);
      fs.symlinkSync(outside, nested, 'dir');
      let directory;
      try {
        directory = await original.opendir(...args);
        const read = directory.read.bind(directory);
        directory.read = (async () => { outsideReads += 1; return await read(); }) as typeof directory.read;
      } finally {
        fs.unlinkSync(nested);
        fs.renameSync(moved, nested);
      }
      return directory;
    }) as typeof original.opendir;
  } else if (mode === 'depth-budget') {
    let current = root;
    for (let i = 0; i < 66; i += 1) { current = join(current, 'd'); fs.mkdirSync(current); }
  } else {
    throw new Error(`Unexpected fixture mode: ${mode}`);
  }
  syncBuiltinESMExports();
  const result = await measureWorktreeReclaimable({ root: targetRoot, excludedPaths, maxEntries, maxDurationMs, signal });
  if (['unreadable', 'allocation-unavailable', 'changed-file', 'directory-swap'].includes(mode ?? '')) {
    assert.ok(injected > 0, JSON.stringify({ mode, root, targetRoot, result, reason: 'fault injection must run' }));
  }
  assert.equal(result.basis, 'exclusive-file-allocation-estimate');
  if (mode === 'accounting' || mode === 'sparse') {
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.estimatedBytes, expectedBytes, 'allocation estimates must not use logical size or count shared files');
    assert.equal(result.observedExclusiveBytes, expectedBytes);
    assert.equal(result.reason, null);
    if (mode === 'accounting') {
      assert.equal(result.excluded.hardlinks, 3);
      assert.equal(result.excluded.symlinks, 1);
      assert.equal(result.excluded.policyPaths, 4);
    }
  } else {
    assert.equal(result.estimatedBytes, null, 'an incomplete measurement must not rank as a complete zero');
    if (mode === 'entry-budget' || mode === 'time-budget' || mode === 'depth-budget' || mode === 'aborted') {
      assert.equal(result.status, 'partial', JSON.stringify(result));
      assert.equal(result.reason, mode);
    } else {
      assert.equal(result.status, 'unavailable', JSON.stringify(result));
      assert.equal(result.reason, mode === 'root-symlink' ? 'symlink-root'
        : mode === 'directory-swap' || mode === 'changed-file' ? 'changed' : mode);
    }
  }
  assert.equal(outsideReads, 0, 'the restored-directory race must be detected before consuming external entries');
  assert.deepEqual(fs.readFileSync(join(root, 'source')), preserved);
  assert.equal(fs.readFileSync(join(outside, 'secret'), 'utf8'), 'must remain external');
  console.log(JSON.stringify({ mode, verified: true }));
} finally {
  fs.promises.lstat = original.lstat;
  fs.promises.opendir = original.opendir;
  syncBuiltinESMExports();
  fs.rmSync(parent, { recursive: true, force: true });
}
