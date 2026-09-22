import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { FileTrustPolicy } from '../../file-trust-policy';
import { ensurePrivateDirectory, verifyPrivateDirectory } from '../private-directory';

const mode = process.argv[2];
assert.ok(['create', 'verify', 'owner-denied', 'access-denied', 'unreadable', 'replaced'].includes(mode ?? ''));
// Match production realpath: native Windows sync/async paths may spell aliases differently.
const root = await fs.promises.realpath(fs.mkdtempSync(join(tmpdir(), 'wtm-private-policy-')));
const target = join(root, 'state');
const retired = join(root, 'retired');
const originalOpen = fs.promises.open;
let openedTarget = false;
const ownershipPaths: string[] = [];
const accessChecks: Array<{ path: string; mask: number }> = [];

// A path-dependent ACL fixture models the port's contract: descriptor uid/mode cannot answer
// ownership or privacy. Only this real fixture subtree is trusted; ancestors and empty paths
// have no ACL evidence. This is not a native ACL measurement or a platform implementation.
function hasAcl(path: string): boolean {
  if (path === '') return false;
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
const policy: FileTrustPolicy = {
  currentIdentityAvailable: () => true,
  isNotSharedByHardLink: (stat) => Number(stat.nlink) === 1,
  async isOwnedByCurrentUser(_stat, path) {
    ownershipPaths.push(path);
    return hasAcl(path) && !(openedTarget && (mode === 'owner-denied' || mode === 'unreadable'));
  },
  async isWritableOnlyByOwner(_stat, path, mask) {
    accessChecks.push({ path, mask });
    return hasAcl(path) && !(openedTarget && mode === 'access-denied');
  },
  // Private-directory checks never ask this; it is here to satisfy the port, and answering from
  // `hasAcl` would imply this fixture models an executability decision it does not.
  isExecutable: () => Promise.resolve(true),
};

try {
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(join(target, 'preserved'), 'original');
  const stat = fs.lstatSync(target);
  fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]) === target) {
      if (mode === 'replaced') {
        // Replace between the pathname snapshot and open, while no directory handle exists.
        // Both trees have the same trust policy; only exact filesystem identity can reject it.
        fs.renameSync(target, retired);
        fs.mkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(join(target, 'preserved'), 'replacement');
      }
      const handle = await originalOpen(...args);
      openedTarget = true;
      return handle;
    }
    return await originalOpen(...args);
  }) as typeof originalOpen;
  syncBuiltinESMExports();

  const run = () => mode === 'verify'
    ? verifyPrivateDirectory({ path: target, identity: { device: stat.dev, inode: stat.ino, mode: stat.mode, uid: stat.uid } }, policy)
    : ensurePrivateDirectory(mode === 'create' ? join(target, 'nested') : target, policy);
  if (mode === 'create' || mode === 'verify') {
    await run();
    if (mode === 'create') assert.equal(fs.lstatSync(join(target, 'nested')).isDirectory(), true);
  } else {
    await assert.rejects(run(), (error: unknown) => {
      // A directory swapped mid-check is a race a retry can win; the other three are refusals only
      // a person can clear (todo item 51).
      assert.equal(
        (error as { code?: string }).code,
        mode === 'replaced' ? 'WTM_PRIVATE_DIRECTORY_UNAVAILABLE' : 'WTM_PRIVATE_DIRECTORY_UNSAFE',
      );
      if (mode !== 'replaced') assert.equal((error as { context?: { path?: string } }).context?.path, target);
      return true;
    });
  }
  assert.equal(openedTarget, true, JSON.stringify({ root, target, ownershipPaths, accessChecks, reason: 'must open the actual target descriptor' }));
  assert.equal(ownershipPaths.includes(''), false, 'descriptor checks need the same canonical ACL path');
  assert.ok(accessChecks.every((check) => check.path !== '' && (check.mask === 0o077 || check.mask === 0o022)));
  // `create` walks up from `target/nested` (which does not exist yet) and finds `target` itself
  // as the nearest existing ancestor -- `inspectPrivateDirectory`'s ancestor-aware check asks the
  // relaxed "no group/other *write*" question (0o022) there, not the strict 0o077 a directory WTM
  // actually owns gets. `assertNoSymlinkComponents`'s own separate walk asks `target` the same
  // relaxed question now too, since `target` is not the final path it was called with (`nested`
  // is); `nested` -- WTM's own, freshly created leaf -- is the one path either check ever holds
  // to the strict mask. Every other mode's target already exists at the exact path requested, so
  // it is never an ancestor and every check on it stays strict.
  if (mode === 'create') {
    assert.ok(accessChecks.some((check) => check.path === target && check.mask === 0o022), JSON.stringify(accessChecks));
  } else {
    assert.ok(accessChecks.every((check) => check.mask === 0o077), JSON.stringify(accessChecks));
  }
  assert.equal(fs.readFileSync(join(mode === 'replaced' ? retired : target, 'preserved'), 'utf8'), 'original');
  if (mode === 'replaced') assert.equal(fs.readFileSync(join(target, 'preserved'), 'utf8'), 'replacement');
  console.log(JSON.stringify({ mode, verified: true }));
} finally {
  fs.promises.open = originalOpen;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
