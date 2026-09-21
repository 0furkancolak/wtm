import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { wtmErrorCodeSchema } from '@wtm/protocol';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../../file-trust-policy';
import { ensurePrivateDirectory, PrivateDirectoryError } from '../private-directory';
import { isWindowsTestHost } from '../../../../testkit/src/platform';

/**
 * Which refusals a retry can clear (todo item 51).
 *
 * A supervised daemon stops on a coded failure in exit class 2 and retries everything else. A
 * directory that is a link, not a directory, someone else's, or readable by others stays that way
 * until a person changes it, so it carries the registered code. A directory that could not be read
 * at all may be a disk or mount that is not there yet, so it must stay uncoded and be retried.
 */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function privateRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wtm-private-class-')));
  await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function refusal(path: string, fileTrust: FileTrustPolicy = defaultCoreFileTrustPolicy): Promise<PrivateDirectoryError> {
  try {
    await ensurePrivateDirectory(path, fileTrust);
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateDirectoryError);
    return error as PrivateDirectoryError;
  }
  throw new Error(`expected ${path} to be refused`);
}

function expectPermanent(error: PrivateDirectoryError, path: string): void {
  expect(error.code).toBe('WTM_PRIVATE_DIRECTORY_UNSAFE');
  expect(wtmErrorCodeSchema.safeParse(error.code).success).toBe(true);
  expect(error.severity).toBe('error');
  expect(error.context.path).toBe(path);
}

/**
 * A policy that answers "somebody else's" for `root`, every ancestor above it, and any extra path
 * named here.
 *
 * `assertNoSymlinkComponents` turns its private-anchor rules on at the first component this user
 * owns at mode 0700, and below that anchor it refuses a file component as "is not a directory"
 * and a link as "is a symbolic link" — both before the `lstat` that would report ENOTDIR or
 * ELOOP. Whether `tmpdir()` already sits below such an anchor is a property of the host, not of
 * the case under test: macOS puts `$TMPDIR` in a per-user 0700 directory, and a shared `/tmp` is
 * nobody's private anchor. A fixture for those two errno branches therefore states that it is
 * outside any private anchor instead of inheriting the answer from wherever the host keeps
 * temporary files.
 */
function outsidePrivateAnchor(root: string, ...alsoForeign: readonly string[]): FileTrustPolicy {
  const foreign = (path: string): boolean => path === root
    || alsoForeign.includes(path)
    || root.startsWith(path.endsWith(sep) ? path : `${path}${sep}`);
  return {
    ...defaultCoreFileTrustPolicy,
    isOwnedByCurrentUser: async (stat, path) => !foreign(path)
      && await defaultCoreFileTrustPolicy.isOwnedByCurrentUser(stat, path),
  };
}

// Real POSIX modes and links. Windows answers the same questions through ACLs, which these
// fixtures cannot set up.
describe.skipIf(isWindowsTestHost)('private directory refusals', () => {
  test('a directory readable by others is permanent, and names the chmod that fixes it', async () => {
    const root = await privateRoot();
    const state = join(root, 'state');
    await mkdir(state);
    await chmod(state, 0o755);

    const error = await refusal(join(state, 'nested'));

    expectPermanent(error, state);
    expect(error.message).toContain('mode 755');
    expect(error.remediation).toEqual([{ kind: 'command-suggestion', argv: ['chmod', '700', state] }]);
  });

  test('a symbolic link is permanent', async () => {
    const root = await privateRoot();
    await mkdir(join(root, 'real'), { mode: 0o700 });
    const link = join(root, 'link');
    await symlink(join(root, 'real'), link);

    const error = await refusal(link);

    expectPermanent(error, link);
    expect(error.context.reason).toBe('is a symbolic link');
    // Removing a link a person made on purpose is not a remedy WTM gets to suggest.
    expect(error.remediation).toEqual([]);
  });

  test('a file where the directory should be is permanent', async () => {
    const root = await privateRoot();
    const file = join(root, 'state');
    await writeFile(file, 'not a directory');

    const error = await refusal(file);

    expectPermanent(error, file);
    expect(error.context.reason).toBe('is not a directory');
  });

  test("another user's directory is permanent", async () => {
    const root = await privateRoot();
    const state = join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    const fileTrust: FileTrustPolicy = {
      ...defaultCoreFileTrustPolicy,
      isOwnedByCurrentUser: async (stat, path) => path !== state && await defaultCoreFileTrustPolicy.isOwnedByCurrentUser(stat, path),
    };

    const error = await refusal(state, fileTrust);

    expectPermanent(error, state);
    expect(error.context.reason).toBe('belongs to another user');
  });

  test("a missing target under another user's directory is retried, as for a volume not mounted yet", async () => {
    const root = await privateRoot();
    // `root` stands in for a root-owned `/home` whose user directory has not been mounted. Its
    // ancestors must be foreign too, as `/` is: a foreign directory *below* this user's own 0700
    // anchor is permanent (no volume mounts there), which is a different case from this one.
    const error = await refusal(join(root, 'me', '.local', 'state', 'wtm'), outsidePrivateAnchor(root));

    expect(error.code).toBe('WTM_PRIVATE_DIRECTORY_UNAVAILABLE');
    expect(error.context.path).toBe(root);
    expect(error.message).not.toContain('unsafe');
  });

  test('a directory that cannot be read stays uncoded, so it is retried', async () => {
    const root = await privateRoot();
    const locked = join(root, 'locked');
    await mkdir(locked, { mode: 0o700 });
    await chmod(locked, 0o000);
    cleanups.push(() => chmod(locked, 0o700));
    // Root reads through mode 000, so there is nothing to observe. The filesystem is asked rather
    // than the process's uid, which @wtm/core may only consult through its FileTrustPolicy.
    if (await readdir(locked).then(() => true, () => false)) return;

    const error = await refusal(join(locked, 'state'));

    expect(error.code).toBe('WTM_PRIVATE_DIRECTORY_UNAVAILABLE');
    expect(wtmErrorCodeSchema.safeParse(error.code).success).toBe(false);
  });
});

/**
 * M2 and M3 of todo item 51's review, both about a refusal being filed in the wrong class.
 *
 * A supervised daemon stops on the coded class and retries everything else, so a misfiled refusal
 * is either a daemon that never comes back from something temporary or one that wakes every ten
 * seconds forever on something only a person can fix.
 */
describe.skipIf(isWindowsTestHost)('private directory refusal classification', () => {
  test('a path component that is a file is permanent, not retried forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-private-notdir-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'file');
    await writeFile(file, 'not a directory');

    const error = await refusal(join(file, 'state'), outsidePrivateAnchor(root));

    expectPermanent(error, join(file, 'state'));
    expect(error.context.reason).toBe('has a path component that is not a directory');
  });

  test('a symbolic link loop on the path is permanent, not retried forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wtm-private-eloop-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const loop = join(root, 'loop');
    await symlink(loop, loop);

    // The link is another user's too: an owned link is refused as "is a symbolic link" first, and
    // the resolution that reports ELOOP never happens.
    const error = await refusal(join(loop, 'state'), outsidePrivateAnchor(root, loop));

    expectPermanent(error, join(loop, 'state'));
    expect(error.context.reason).toBe('is reached through a symbolic link loop');
  });

  /**
   * M3. The port's predicates fail closed, so `false` covers both "somebody else owns it" and
   * "there was no answer to read". On Windows the second is a `powershell.exe` that died, timed
   * out or lost a contended runner, and reading it as the first stopped a supervised daemon for
   * good while telling the user their own directory belongs to somebody else.
   */
  test('an ownership answer that could not be read is retried, not called another user\'s', async () => {
    const root = await privateRoot();
    const state = join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    const fileTrust: FileTrustPolicy = {
      ...defaultCoreFileTrustPolicy,
      isOwnedByCurrentUser: async (stat, path) => path !== state
        && await defaultCoreFileTrustPolicy.isOwnedByCurrentUser(stat, path),
      ownershipReadable: async (path) => path !== state,
    };

    const error = await refusal(state, fileTrust);

    expect(error.code).toBe('WTM_PRIVATE_DIRECTORY_UNAVAILABLE');
    expect(error.context.path).toBe(state);
    expect(error.context.reason).toBe('ownership could not be read');
    expect(error.message).not.toContain('unsafe');
    expect(error.message).not.toContain('another user');
  });

  test('a permission answer that could not be read is retried, not called readable by others', async () => {
    const root = await privateRoot();
    const state = join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    const fileTrust: FileTrustPolicy = {
      ...defaultCoreFileTrustPolicy,
      isWritableOnlyByOwner: async (stat, path, mask) => path !== state
        && await defaultCoreFileTrustPolicy.isWritableOnlyByOwner(stat, path, mask),
      ownershipReadable: async (path) => path !== state,
    };

    const error = await refusal(state, fileTrust);

    expect(error.code).toBe('WTM_PRIVATE_DIRECTORY_UNAVAILABLE');
    expect(error.context.reason).toBe('ownership could not be read');
    expect(error.remediation).toEqual([]);
  });

  test('a policy without the optional question keeps every refusal exactly as it was', async () => {
    const root = await privateRoot();
    const state = join(root, 'state');
    await mkdir(state, { mode: 0o700 });
    expect(defaultCoreFileTrustPolicy.ownershipReadable).toBeUndefined();
    const fileTrust: FileTrustPolicy = {
      ...defaultCoreFileTrustPolicy,
      isOwnedByCurrentUser: async (stat, path) => path !== state
        && await defaultCoreFileTrustPolicy.isOwnedByCurrentUser(stat, path),
    };

    const error = await refusal(state, fileTrust);

    expectPermanent(error, state);
    expect(error.context.reason).toBe('belongs to another user');
  });
});
