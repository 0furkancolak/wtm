import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isWindowsTestHost } from './platform';

const execFileAsync = promisify(execFile);

/**
 * The well-known `Everyone` SID — every principal, authenticated or not, on every Windows
 * installation. Constant, and unlike a user or group name it is neither localized nor renamable.
 */
const everyoneSid = 'S-1-1-0';

/**
 * Opens `path` to somebody who is neither its owner nor a principal WTM trusts, so a test can put
 * a directory in the state the private-state checks exist to refuse.
 *
 * `chmod(path, 0o755)` is what the POSIX half always did, and on Windows it is not a weaker
 * version of that — it is nothing at all. Node maps a mode onto the read-only attribute and
 * nothing else, so a `0o755` there leaves the ACL exactly as `mkdir` made it: owner-only, which is
 * the *safe* state. Every test that built its insecure directory that way was handing the code
 * under test a perfectly private directory on win32 and then asserting it be refused, which is why
 * `adapter.test.ts`'s `insecureMode` case reported `ok: true` — the command was right and the
 * fixture had no premise.
 *
 * The NTFS equivalent of "group and other can get in" is an access-control entry granting a
 * principal outside that set. This grants `Everyone` read and execute, which is the closest
 * analogue of `0o755`'s `r-x` for group and other: the widest principal there is, no write. That
 * is what `isWritableOnlyByOwner(..., 0o077)` refuses — under that mask any `Allow` rule for a
 * principal that is neither the current user nor a well-known trusted SID denies the directory,
 * read-only or not — so the refusal the test asserts is the one the policy actually makes, reached
 * through the ACL it actually reads.
 *
 * A failure here throws rather than being swallowed: a fixture that cannot create its premise must
 * say so, since the alternative is the silent pass this function exists to end.
 */
export async function grantForeignDirectoryAccess(path: string): Promise<void> {
  if (!isWindowsTestHost) {
    await chmod(path, 0o755);
    return;
  }
  // `*SID` is how `icacls` takes a security identifier rather than a display name. `(RX)` is read
  // and execute on the directory itself; no inheritance flags, because the checks read the ACL of
  // the directory they are standing on rather than of anything under it.
  await execFileAsync('icacls', [path, '/grant', `*${everyoneSid}:(RX)`], {
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}
