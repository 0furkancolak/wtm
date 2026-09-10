import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { measureWorktreeReclaimable } from '@wtm/core';
import { readLinuxMountBoundaries } from '../../../platform/src/mounts/linux';
import { measureCleanupCandidates } from '../commands/cleanup-estimates';

// Only the kernel mount-table boundary is substituted. Directory iteration, allocated-block
// accounting, path guards and inode pins use the real temporary filesystem. This does not
// create a bind mount or claim native mount/unmount evidence on the executing host.
const mode = process.argv[2];
const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'wtm-mount-evidence-')));
const root = join(parent, 'worktree');
const tablePath = join(parent, 'mountinfo');
const mounted = join(root, mode === 'escaped-path' ? 'mounted space' : 'mounted');
const original = { open: fs.promises.open, opendir: fs.promises.opendir };
let mountedReads = 0;
let mountBytesRead = 0;
let mutated = false;

const encode = (path: string): string => path.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');
const line = (id: number, mountpoint: string, options = 'rw', parentId = 1): string =>
  `${String(id)} ${String(parentId)} 8:1 / ${encode(mountpoint)} ${options} - ext4 /dev/test rw\n`;
const top = () => line(1, parse(root).root);
const evidence = (extra = '') => top() + line(2, root) + extra;

try {
  fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'source'), Buffer.alloc(4096));
  if (mode === 'same-device-file') fs.writeFileSync(mounted, Buffer.alloc(8192));
  else { fs.mkdirSync(mounted); fs.writeFileSync(join(mounted, 'external'), Buffer.alloc(8192)); }
  assert.equal(fs.lstatSync(root).dev, fs.lstatSync(mounted).dev, 'fixture must expose why st_dev alone cannot distinguish a mount');
  let contents: string | Buffer = evidence(line(3, mounted, 'rw', 2));
  // Control characters are legal in a mount-table path but not in a native Windows filename.
  // Exercise their decoding in an unrelated record without needing to create that path.
  if (mode === 'escaped-path') contents += line(4, join(parent, 'unused\ttab\nnewline\\slash'));
  if (mode === 'root-mount' || mode === 'unrelated-changed') contents = evidence();
  else if (mode === 'malformed') contents = evidence('not a mount record\n');
  else if (mode === 'duplicate-id') contents = evidence(line(2, mounted));
  else if (mode === 'invalid-utf8') contents = Buffer.concat([Buffer.from(evidence()), Buffer.from([0xff, 0x0a])]);
  else if (mode === 'byte-budget') contents = evidence() + ' '.repeat(1024 * 1024 + 8);
  else if (mode === 'record-budget') contents = evidence() + Array.from({ length: 20_001 }, (_, index) => line(index + 3, '/x')).join('');
  fs.writeFileSync(tablePath, contents);

  fs.promises.open = (async (...args: Parameters<typeof original.open>) => {
    if (String(args[0]) !== '/proc/self/mountinfo') return await original.open(...args);
    if (mode === 'unreadable') throw Object.assign(new Error('private mount evidence'), { code: 'EACCES' });
    const handle = await original.open(tablePath, args[1], args[2]);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      mountBytesRead += result.bytesRead;
      return result;
    }) as typeof handle.read;
    return handle;
  }) as typeof original.open;
  fs.promises.opendir = (async (...args: Parameters<typeof original.opendir>) => {
    if (String(args[0]) === mounted) mountedReads += 1;
    if (String(args[0]) === root && !mutated) {
      mutated = true;
      if (mode === 'descendant-changed') fs.writeFileSync(tablePath, evidence(line(4, mounted, 'rw', 2)));
      else if (mode === 'ancestor-changed') fs.writeFileSync(tablePath, top() + line(2, root, 'ro') + line(3, mounted, 'rw', 2));
      else if (mode === 'unrelated-changed') fs.writeFileSync(tablePath, evidence(line(4, join(dirname(parent), 'unrelated-mount'))));
    }
    return await original.opendir(...args);
  }) as typeof original.opendir;
  syncBuiltinESMExports();

  const result = mode === 'same-device-directory'
    ? (await measureCleanupCandidates([{ path: root, loadConfig: async () => ({ config: {}, context: {} }) }], {
      readMountBoundaries: readLinuxMountBoundaries, maxDurationMs: 5_000,
    })).get(root)!
    : await measureWorktreeReclaimable({ root, readMountBoundaries: readLinuxMountBoundaries, maxDurationMs: 5_000 });
  if (['same-device-directory', 'same-device-file', 'escaped-path', 'root-mount', 'unrelated-changed'].includes(mode!)) {
    const expected = fs.lstatSync(join(root, 'source')).blocks * 512
      + (mode === 'root-mount' || mode === 'unrelated-changed' ? fs.lstatSync(join(mounted, 'external')).blocks * 512 : 0);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.estimatedBytes, expected, 'mounted bytes must not be attributed to the worktree being reclaimed');
    assert.equal(result.excluded.mounts, mode === 'root-mount' || mode === 'unrelated-changed' ? 0 : 1);
    if (mode !== 'root-mount' && mode !== 'unrelated-changed') assert.equal(mountedReads, 0, 'mounted subtree must not be opened');
  } else {
    assert.equal(result.status, 'unavailable', JSON.stringify(result));
    assert.equal(result.estimatedBytes, null, 'missing or changed mount evidence is not a complete estimate');
    assert.equal(result.reason, mode === 'descendant-changed' || mode === 'ancestor-changed'
      ? 'mount-evidence-changed' : 'mount-evidence-unavailable');
  }
  assert.ok(mountBytesRead <= 2 * (1024 * 1024 + 1), 'mount-table reads must have a fixed byte bound per snapshot');
  assert.ok(!JSON.stringify(result).includes('private mount evidence'));
  assert.equal(fs.statSync(join(root, 'source')).size, 4096);
  console.log(JSON.stringify({ mode, verified: true }));
} finally {
  fs.promises.open = original.open;
  fs.promises.opendir = original.opendir;
  syncBuiltinESMExports();
  fs.rmSync(parent, { recursive: true, force: true });
}
