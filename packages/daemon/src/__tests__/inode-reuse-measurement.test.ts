import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinInode } from '@wtm/core/resources/guard';

/**
 * The experiment behind `InodePin`, run against the filesystem this suite is executing on.
 *
 * Every other test of the identity checks is a test *about* a race: it stages a substitution and
 * asserts the product refuses. Those tests were correct, present and passing for the whole of this
 * project's life, and on 2026-09-02 six of them failed on the first Linux runner (33648234137) --
 * not because the races changed, but because of a filesystem property nobody had written down.
 * APFS never hands a deleted inode number back; ext4 and tmpfs hand it back immediately, so
 * `rm(p)` followed by a create at `p` produced an object that `(dev, ino, uid)` called identical
 * and the destructive-operation core removed the replacement it existed to preserve.
 *
 * This file is the only test in the repository that can say whether that is still true. It is
 * modelled on `platform/src/socket/__tests__/limit-measurement.test.ts`, which did the same job
 * for the socket path limit, and for the same reason: a constant nobody measures is a constant
 * that goes on being cited after it stops being true.
 *
 * Unlike the socket measurement it runs in process. Bun's Unix socket limit is Bun's own, which is
 * why that one had to be a Node child; an inode number is the kernel's answer to `stat` and no
 * runtime is between us and it.
 *
 * There is deliberately no skip. A measurement that quietly did not happen is worse than none: the
 * comment on `InodePin` would go on claiming a provenance this file was supposed to supply.
 *
 * It lives in `@wtm/daemon` and not beside `InodePin` in `@wtm/core` because of spec D8: core and
 * protocol may not know what operating system they are running on, in tests and in comments, and
 * `platform-independence.test.ts` enforces it. This file's entire job is to assert two different
 * answers for two named platforms, which is precisely the knowledge core is not allowed to hold.
 * The daemon is the composition root's neighbour, it may branch on the host, it depends on
 * `@wtm/core`, and its `service-lifecycle.ts` is the other consumer of the predicate being
 * measured -- so this is the nearest home the dependency graph allows, not a workaround for the
 * guard.
 */

const trials = 16;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-inode-measurement-'));
  roots.push(root);
  return root;
}

function hostPlatform(): 'darwin' | 'linux' {
  // Nothing here can run elsewhere; the guard exists so the failure says which platform was
  // unaccounted for rather than silently measuring one and asserting the other's answer.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`no measured inode-reuse expectation for ${process.platform}`);
  }
  return process.platform;
}

type Make = (path: string) => Promise<void>;

const makeFile: Make = async (path) => { await writeFile(path, 'x', { mode: 0o600 }); };
const makeDirectory: Make = async (path) => { await mkdir(path, { mode: 0o700 }); };

/** How many of `trials` delete-then-recreate cycles at one path got the same inode number back. */
async function countReuse(make: Make, pinned: boolean): Promise<number> {
  const root = await fixture();
  let reused = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const path = join(root, `subject-${trial}`);
    await make(path);
    const before = await stat(path);
    const pin = pinned ? await pinInode(path) : null;
    if (pinned && pin === null) throw new Error('the subject could not be pinned');
    await rm(path, { recursive: true });
    await make(path);
    const after = await stat(path);
    if (Number(after.dev) === Number(before.dev) && Number(after.ino) === Number(before.ino)) reused += 1;
    await pin?.close();
    await rm(path, { recursive: true });
  }
  return reused;
}

describe('inode-number reuse, measured on this filesystem', () => {
  test('an unpinned inode number comes back on Linux and never on darwin', async () => {
    const [files, directories] = [await countReuse(makeFile, false), await countReuse(makeDirectory, false)];

    if (hostPlatform() === 'darwin') {
      // The property the six TOCTOU tests were silently resting on. Asserted as "never", not
      // "usually": one reuse here would mean the darwin half of the suite had been proving
      // something weaker than it claimed all along.
      expect({ files, directories }).toEqual({ files: 0, directories: 0 });
    } else {
      // Asserted as "at least once" rather than "always". The claim F9 rests on is that the
      // allocator *may* reissue immediately, which is all a racer needs; pinning it to every
      // trial would be pinning an allocation policy this project does not depend on.
      expect(files).toBeGreaterThan(0);
      expect(directories).toBeGreaterThan(0);
    }
  });

  test('a pinned inode number is never reissued, on either platform', async () => {
    // The premise of the fix, and the half of it that is measurable here: the kernel does not free
    // an inode a descriptor still references, so its number cannot be handed to the replacement.
    // On darwin this is vacuous -- nothing is reissued anyway -- and on Linux it is the whole
    // reason `(dev, ino, uid)` comparisons against a pinned snapshot became true again.
    expect(await countReuse(makeFile, true)).toBe(0);
    expect(await countReuse(makeDirectory, true)).toBe(0);
  });

  test('a pinned file reports nlink 0 once unlinked; a pinned directory does so only on Linux', async () => {
    const root = await fixture();
    const file = join(root, 'file');
    await writeFile(file, 'x', { mode: 0o600 });
    const filePin = await pinInode(file);
    const directory = join(root, 'directory');
    await mkdir(directory, { mode: 0o700 });
    const directoryPin = await pinInode(directory);
    if (filePin === null || directoryPin === null) throw new Error('the subjects could not be pinned');

    const beforeFile = await stat(file);
    const beforeDirectory = await stat(directory);
    expect(await filePin.holds(beforeFile)).toBe(true);
    expect(await directoryPin.holds(beforeDirectory)).toBe(true);

    await rm(file);
    await rm(directory, { recursive: true });

    // `holds` is deliberately two clauses, and this is why. The link-count clause is the direct
    // answer -- *the object I inspected is gone* -- but darwin never clears `nlink` on a
    // descriptor whose directory has been removed, so for directories it answers only on Linux.
    // The tuple clause covers exactly that gap, because darwin is also the platform that never
    // reissues the number. Neither clause is sufficient alone on both platforms, which is why the
    // predicate cannot be simplified to either one.
    expect(await filePin.holds({ dev: beforeFile.dev, ino: beforeFile.ino, uid: beforeFile.uid })).toBe(false);
    const directoryStillLinked = await directoryPin.holds({
      dev: beforeDirectory.dev, ino: beforeDirectory.ino, uid: beforeDirectory.uid,
    });
    expect(directoryStillLinked).toBe(hostPlatform() === 'darwin');

    await filePin.close();
    await directoryPin.close();
  });
});
