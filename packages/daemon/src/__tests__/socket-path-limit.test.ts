import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonSocketPathTooLongError,
  boundDaemonSocketPath,
  daemonSocketFileName,
  daemonSocketPathLimitBytes,
  publishedDaemonSocketPath,
} from '@wtm/core';
import { createProductionDaemon, defaultProductionRuntimePaths } from '../runtime-factory';
import { UnixIpcServer } from '../server';

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

describe('daemon socket path preflight', () => {
  test('the IPC server refuses a path past the limit before it binds anything', async () => {
    const directory = await directoryForSocketBytes(daemonSocketPathLimitBytes + 1);
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
    expect(error.message).toContain(String(daemonSocketPathLimitBytes + 1));
    expect(error.message).toContain(String(daemonSocketPathLimitBytes));
    expect(error.message).toContain(socketPath);
    // Nothing was bound and nothing was linked: the refusal precedes `listen`, so neither the
    // published name nor the private bind name exists.
    expect(await missing(socketPath)).toBe(true);
    expect(await missing(boundDaemonSocketPath(socketPath))).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  test('a path exactly at the limit is not refused', async () => {
    const directory = await directoryForSocketBytes(daemonSocketPathLimitBytes);
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
    const directory = await directoryForSocketBytes(daemonSocketPathLimitBytes + 8);
    const dataRoot = join(directory, 'nested');

    const failure = await createProductionDaemon({ dataRoot }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonSocketPathTooLongError);
    expect((failure as DaemonSocketPathTooLongError).code).toBe('WTM_SOCKET_PATH_TOO_LONG');
    expect(await missing(dataRoot)).toBe(true);
  });

  test('the factory derives the socket path from the shared definition', () => {
    const home = '/Users/somebody';

    expect(defaultProductionRuntimePaths(home).socketPath).toBe(publishedDaemonSocketPath(home));
  });
});
