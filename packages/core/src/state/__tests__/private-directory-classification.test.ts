import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
