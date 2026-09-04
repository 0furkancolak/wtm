import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonSocketPathTooLongError,
  boundDaemonSocketPath,
  daemonSocketFileName,
  publishedDaemonSocketPath,
} from '@wtm/platform/socket';
import { selectPlatformRuntime } from '@wtm/platform';
import { createProductionDaemon, defaultProductionRuntimePaths } from '../runtime-factory';
import { UnixIpcServer } from '../server';

/**
 * The macOS socket root, spelled out rather than read from `PlatformRuntime.paths.socketRoot`.
 *
 * It is deliberately not the derivation under test: an assertion that computed the expected path
 * the same way the factory does would pass whatever the factory decided. The full pinning of all
 * five macOS paths to literal strings lives in `runtime-factory.test.ts`; this one keeps the
 * socket path tied to the shared `publishedDaemonSocketPath` definition.
 */
function darwinSocketRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'WTM');
}

/**
 * `sizeof(sun_path)` for the machine this file runs on: 104 bytes on macOS, 108 on Linux.
 *
 * The three tests below bind — or refuse to bind — on *this* host, through a server and a factory
 * that both read the host's own policy. Sized against `darwinSocketPathLimitBytes` they built a
 * 105-byte fixture, which macOS refuses and Linux binds without complaint: on Linux the refusal
 * these tests are named for simply never happened and `failure` came back null. The claim is
 * "one byte past the limit"; 105 was an accident of macOS.
 */
const hostLimitBytes = selectPlatformRuntime().socket.limitBytes;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A directory whose socket path lands exactly `overBy` bytes past the limit.
 *
 * The failure is a property of the path's length, so the fixture has to hit a length rather
 * than merely be "deep". Everything is created for real: a refusal that only happened because
 * the directory was missing would prove nothing.
 */
async function directoryForSocketBytes(bytes: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wtm-sp-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const target = bytes - daemonSocketFileName.length - 1;
  let directory = root;
  while (target - directory.length > 65) {
    directory = join(directory, 'd'.repeat(60));
  }
  const remaining = target - directory.length - 1;
  if (remaining < 1) throw new Error(`temporary root is already too long for ${bytes} bytes`);
  directory = join(directory, 'd'.repeat(remaining));
  await mkdir(directory, { recursive: true });
  if (Buffer.byteLength(join(directory, daemonSocketFileName)) !== bytes) {
    throw new Error('fixture did not hit the requested socket path length');
  }
  return directory;
}

async function missing(path: string): Promise<boolean> {
  try { await stat(path); return false; }
  catch { return true; }
}

// `socket-path.ts` measures a Unix domain socket's `sun_path` byte limit, a POSIX-only concept.
// Windows addresses the daemon over a named pipe instead (see `windowsPlatformPaths.socketRoot`
// in `packages/platform/src/paths/platform-paths.ts`), so there is no `sun_path` limit for this
// suite to preflight against, and `UnixIpcServer`/`createProductionDaemon` are not the code path
// a Windows host runs. Only the tests below that actually bind on this host are gated; the
// cross-platform derivation check further down injects its platforms and needs no gate.
(process.platform !== 'win32' ? describe : describe.skip)('daemon socket path preflight', () => {
  test('the IPC server refuses a path past the limit before it binds anything', async () => {
    const directory = await directoryForSocketBytes(hostLimitBytes + 1);
    const socketPath = join(directory, daemonSocketFileName);
    const server = new UnixIpcServer({
      socketPath,
      handler: () => { throw new Error('unreachable'); },
    });
    cleanups.push(() => server.close().catch(() => {}));

    const failure = await server.start().then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonSocketPathTooLongError);
    const error = failure as DaemonSocketPathTooLongError;
    expect(error.code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(error.message).toContain(String(hostLimitBytes + 1));
    expect(error.message).toContain(String(hostLimitBytes));
    expect(error.message).toContain(socketPath);
    // Nothing was bound and nothing was linked: the refusal precedes `listen`, so neither the
    // published name nor the private bind name exists.
    expect(await missing(socketPath)).toBe(true);
    expect(await missing(boundDaemonSocketPath(socketPath))).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test('a path exactly at the limit is not refused', async () => {
    const directory = await directoryForSocketBytes(hostLimitBytes);
    const socketPath = join(directory, daemonSocketFileName);
    const server = new UnixIpcServer({
      socketPath,
      handler: () => { throw new Error('unreachable'); },
    });
    cleanups.push(() => server.close().catch(() => {}));

    await server.start();

    expect((await stat(socketPath)).isSocket()).toBe(true);
  });

  test('the production runtime factory refuses before creating its data directory', async () => {
    const directory = await directoryForSocketBytes(hostLimitBytes + 8);
    const dataRoot = join(directory, 'nested');

    const failure = await createProductionDaemon({ dataRoot }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonSocketPathTooLongError);
    expect((failure as DaemonSocketPathTooLongError).code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(await missing(dataRoot)).toBe(true);
  });
});

describe('daemon socket path derivation', () => {
  test('the factory derives the socket path from the shared definition, on either platform', () => {
    // Named platforms rather than this host. The claim — that the socket path is
    // `publishedDaemonSocketPath` applied to whatever the platform calls its socket root — is as
    // true of the platform this suite is not running on, and asking the host would have made the
    // expected value follow the answer instead of pinning it. Unlike the preflight tests above,
    // nothing here binds a real socket, so it runs on every host, Windows included.
    //
    // Linux is the leg with teeth. Its socket root is not its data root, so a factory that went
    // back to `join(dataRoot, daemonSocketFileName)` would still satisfy the macOS line above.
    expect(defaultProductionRuntimePaths('/Users/somebody', { platform: 'darwin', env: {} }).socketPath)
      .toBe(publishedDaemonSocketPath(darwinSocketRoot('/Users/somebody')));
    expect(defaultProductionRuntimePaths('/home/somebody', {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    }).socketPath).toBe(publishedDaemonSocketPath('/run/user/1000/wtm'));
  });
});
