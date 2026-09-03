/**
 * `UnixSocketPublisher`: `packages/daemon/src/server.ts`'s hardlink-publish/chmod/uid dance,
 * moved into `@wtm/platform` unchanged (spec `2026-09-03-windows-trust-and-transport-seam.md`,
 * D7). Every function below is the same logic that used to live as `UnixIpcServer` private methods
 * and module-level helpers — restructured from instance fields into a closure captured by each
 * `publish()` call, because a publisher has no server-lifetime identity of its own to hang fields
 * off, but not rewritten. `server.ts`'s own tests, unmodified, are what prove this.
 */
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createConnection, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { boundDaemonSocketPath } from '../socket';
import type { IpcServerPublisher, PublishedIpcServer, PublishOptions } from './types';

interface SocketIdentity {
  dev: number;
  ino: number;
  uid: number;
}

interface DirectoryIdentity extends SocketIdentity {
  uid: number;
}

interface QuarantinedPath {
  path: string;
  identity: SocketIdentity;
  changedDuringQuarantine: boolean;
}

export function createUnixSocketPublisher(): IpcServerPublisher {
  return { publish };
}

async function publish(
  server: Server,
  address: string,
  options: PublishOptions = {},
): Promise<PublishedIpcServer> {
  const beforeOwnedSocketQuarantine = options.beforeOwnedSocketQuarantine ?? (() => {});
  const afterPrivateSocketQuarantine = options.afterPrivateSocketQuarantine ?? (() => {});

  const parent = await secureSocketParent(dirname(address));
  await prepareSocketPath(address, parent, {
    probe: options.probeExistingSocket ?? socketAcceptsConnections,
    beforeQuarantine: options.beforeStaleSocketQuarantine ?? (() => {}),
  });
  const boundPath = boundDaemonSocketPath(address);
  await prepareSocketPath(boundPath, parent, {
    probe: socketAcceptsConnections,
    beforeQuarantine: () => {},
  });

  let rememberedBoundSocketPath: string | null = null;
  let boundSocket: SocketIdentity | null = null;
  let boundSocketPath: string | null = null;
  let ownedSocket: SocketIdentity | null = null;

  try {
    await listen(server, boundPath);
    rememberedBoundSocketPath = boundPath;
    const stat = await lstat(boundPath);
    const currentUid = process.getuid?.();
    if (!stat.isSocket() || currentUid === undefined || stat.uid !== currentUid) {
      throw new Error('Created IPC path is not a current-user Unix socket');
    }
    const identity: SocketIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    boundSocket = identity;
    boundSocketPath = boundPath;
    await link(boundPath, address);
    const published = await lstat(address);
    if (!matchesSocketIdentity(published, identity)) {
      throw new Error('Published IPC socket does not match the bound socket');
    }
    const linkedPrivate = await lstat(boundPath);
    if (!matchesSocketIdentity(linkedPrivate, identity)) {
      throw new Error('Private IPC socket changed during publication');
    }
    ownedSocket = identity;
    const publishedMode = published.mode & 0o777;
    await quarantineAndUnlink(boundSocketPath, parent, boundSocket, {
      mismatchMessage: 'Bound IPC socket changed during cleanup',
    });
    boundSocketPath = null;
    boundSocket = null;
    const privateRemoved = await lstat(address);
    if (
      !matchesSocketIdentity(privateRemoved, identity)
      || (privateRemoved.mode & 0o777) !== publishedMode
    ) {
      throw new Error('Published IPC socket changed while removing the private bind entry');
    }
    await options.beforeSocketChmod?.();
    const beforeChmod = await lstat(address);
    if (!matchesSocketIdentity(beforeChmod, identity)) {
      throw new Error('IPC socket changed before permissions were secured');
    }
    await chmod(address, 0o600);
    await options.afterSocketChmod?.(address);
    await assertDirectoryIdentity(
      dirname(address),
      parent,
      'IPC socket parent changed after permissions were secured',
    );
    const secured = await lstat(address);
    if (!matchesSocketIdentity(secured, identity) || (secured.mode & 0o777) !== 0o600) {
      throw new Error('IPC socket changed after permissions were secured');
    }

    return {
      address,
      async unpublish(): Promise<void> {
        let failure: unknown;
        if (server.listening) {
          try {
            await closeServerWithPrivatePathShield(
              server,
              rememberedBoundSocketPath,
              parent,
              afterPrivateSocketQuarantine,
            );
          } catch (error) {
            failure ??= error;
          }
        }
        try {
          if (ownedSocket !== null) {
            await quarantineAndUnlink(address, parent, ownedSocket, {
              beforeQuarantine: beforeOwnedSocketQuarantine,
              mismatchMessage: 'IPC socket changed while quarantining owned socket',
            });
            ownedSocket = null;
          }
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) throw failure;
      },
    };
  } catch (error) {
    if (server.listening) {
      try {
        await closeServerWithPrivatePathShield(
          server,
          rememberedBoundSocketPath,
          parent,
          afterPrivateSocketQuarantine,
        );
      } catch { /* Preserve the startup failure. */ }
    }
    try {
      if (boundSocketPath !== null && boundSocket !== null) {
        await quarantineAndUnlink(boundSocketPath, parent, boundSocket, {
          mismatchMessage: 'Bound IPC socket changed during cleanup',
        });
      }
    } catch { /* Preserve the startup failure. */ }
    try {
      if (ownedSocket !== null) {
        await quarantineAndUnlink(address, parent, ownedSocket, {
          beforeQuarantine: beforeOwnedSocketQuarantine,
          mismatchMessage: 'IPC socket changed while quarantining owned socket',
        });
      }
    } catch { /* Preserve the startup failure. */ }
    throw error;
  }
}

async function closeServerWithPrivatePathShield(
  server: Server,
  path: string | null,
  parent: DirectoryIdentity,
  afterPrivateSocketQuarantine: () => Promise<void> | void,
): Promise<void> {
  if (path === null) {
    await closeServer(server);
    return;
  }

  let failure: unknown;
  let original: QuarantinedPath | null = null;
  let installed: Awaited<ReturnType<typeof installClosePlaceholder>> | null = null;
  try {
    original = await quarantinePathIfExists(path, parent);
    if (original?.changedDuringQuarantine === true) {
      failure = new Error('IPC private socket close shield observed a quarantine race');
    }
  } catch (error) {
    failure ??= error;
  }

  try {
    await afterPrivateSocketQuarantine();
  } catch (error) {
    failure ??= error;
  }

  try {
    installed = await installClosePlaceholder(path, parent);
    if (installed.quarantinedRaces.length > 0) {
      failure ??= new Error('IPC private socket close shield retained a raced occupant');
    }
  } catch (error) {
    failure ??= error;
  }

  try {
    await closeServer(server);
  } catch (error) {
    failure ??= error;
  }

  try {
    await assertDirectoryIdentity(
      dirname(path),
      parent,
      `IPC socket parent changed after private socket close shield: ${path}`,
    );
    const survivor = await quarantinePathIfExists(path, parent);
    if (survivor !== null) {
      if (installed !== null && matchesPathIdentity(survivor.identity, installed.placeholder)) {
        try {
          await unlinkVerifiedQuarantine(survivor, parent);
        } catch (error) {
          failure ??= error;
        }
        failure ??= new Error('IPC private socket close shield placeholder survived server close');
      } else {
        failure ??= new Error('IPC private socket close shield retained a post-close occupant');
      }
    }
  } catch (error) {
    failure ??= error;
  }

  if (original !== null) {
    try {
      const restored = await restoreQuarantinedPathWithoutOverwrite(original, path, parent);
      if (!restored) {
        failure ??= new Error('IPC private socket close shield could not restore its quarantined occupant');
      }
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) throw failure;
}

async function secureSocketParent(path: string): Promise<DirectoryIdentity> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const initial = await lstat(path);
  const currentUid = process.getuid?.();
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`IPC socket parent is not a directory: ${path}`);
  }
  if (currentUid === undefined || initial.uid !== currentUid) {
    throw new Error(`IPC socket parent is not owned by the current user: ${path}`);
  }
  await chmod(path, 0o700);
  const secured = await lstat(path);
  if (
    !secured.isDirectory()
    || secured.isSymbolicLink()
    || secured.uid !== initial.uid
    || secured.dev !== initial.dev
    || secured.ino !== initial.ino
    || (secured.mode & 0o777) !== 0o700
  ) {
    throw new Error(`IPC socket parent changed while securing permissions: ${path}`);
  }
  return { dev: secured.dev, ino: secured.ino, uid: secured.uid };
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  message: string,
): Promise<void> {
  const current = await lstat(path);
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || current.uid !== expected.uid
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (current.mode & 0o777) !== 0o700
  ) {
    throw new Error(message);
  }
}

async function prepareSocketPath(
  path: string,
  parent: DirectoryIdentity,
  hooks: {
    probe: (path: string) => Promise<boolean>;
    beforeQuarantine: () => Promise<void> | void;
  },
): Promise<void> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }
  if (!initial.isSocket()) throw new Error(`IPC path exists and is not a Unix socket: ${path}`);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || initial.uid !== currentUid) {
    throw new Error(`IPC socket is not owned by the current user: ${path}`);
  }
  if (await hooks.probe(path)) throw new Error(`IPC socket is already in use: ${path}`);
  await quarantineAndUnlink(path, parent, {
    dev: initial.dev,
    ino: initial.ino,
    uid: initial.uid,
  }, {
    beforeQuarantine: hooks.beforeQuarantine,
    mismatchMessage: `IPC socket changed while checking stale ownership: ${path}`,
  });
}

async function quarantineAndUnlink(
  path: string,
  parent: DirectoryIdentity,
  expected: SocketIdentity,
  options: {
    beforeQuarantine?: () => Promise<void> | void;
    mismatchMessage: string;
  },
): Promise<void> {
  await options.beforeQuarantine?.();
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed while quarantining: ${path}`,
  );
  const quarantinePath = uniqueSiblingPath(path, 'q');
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return;
    throw error;
  }

  let candidate;
  try {
    candidate = await lstat(quarantinePath);
  } catch (error) {
    await restoreQuarantinedPath(quarantinePath, path);
    throw error;
  }
  if (!matchesSocketIdentity(candidate, expected)) {
    await restoreQuarantinedPath(quarantinePath, path);
    throw new Error(options.mismatchMessage);
  }
  await unlink(quarantinePath);
}

async function restoreQuarantinedPath(quarantinePath: string, originalPath: string): Promise<void> {
  try {
    await link(quarantinePath, originalPath);
  } catch {
    // Fail closed: never overwrite a path that appeared while restoring.
    return;
  }
  try {
    await unlink(quarantinePath);
  } catch {
    // The candidate remains reachable from its restored original path.
  }
}

function matchesSocketIdentity(
  stat: Awaited<ReturnType<typeof lstat>>,
  expected: SocketIdentity,
): boolean {
  return stat.isSocket()
    && stat.uid === expected.uid
    && stat.dev === expected.dev
    && stat.ino === expected.ino;
}

function uniqueSiblingPath(path: string, marker: string): string {
  return join(dirname(path), `.${marker}${randomUUID().replaceAll('-', '')}`);
}

async function installClosePlaceholder(
  path: string,
  parent: DirectoryIdentity,
): Promise<{ placeholder: SocketIdentity; quarantinedRaces: QuarantinedPath[] }> {
  const quarantinedRaces: QuarantinedPath[] = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await assertDirectoryIdentity(
      dirname(path),
      parent,
      `IPC socket parent changed while installing private socket close shield: ${path}`,
    );
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) throw error;
      const raced = await quarantinePathIfExists(path, parent);
      if (raced !== null) quarantinedRaces.push(raced);
      continue;
    }

    let placeholder: SocketIdentity;
    try {
      await handle.chmod(0o600);
      const stat = await handle.stat();
      const currentUid = process.getuid?.();
      if (
        !stat.isFile()
        || currentUid === undefined
        || stat.uid !== currentUid
        || (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error('IPC private socket close shield created an invalid placeholder');
      }
      placeholder = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    } finally {
      await handle.close();
    }

    await assertDirectoryIdentity(
      dirname(path),
      parent,
      `IPC socket parent changed after installing private socket close shield: ${path}`,
    );
    let published;
    try {
      published = await lstat(path);
    } catch (error) {
      if (isFileError(error, 'ENOENT')) continue;
      throw error;
    }
    if (
      published.isFile()
      && (published.mode & 0o777) === 0o600
      && matchesPathIdentity(published, placeholder)
    ) {
      return { placeholder, quarantinedRaces };
    }
    const raced = await quarantinePathIfExists(path, parent);
    if (raced !== null) quarantinedRaces.push(raced);
  }
  throw new Error('IPC private socket close shield could not install its placeholder');
}

async function quarantinePathIfExists(
  path: string,
  parent: DirectoryIdentity,
): Promise<QuarantinedPath | null> {
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed while applying private socket close shield: ${path}`,
  );
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  }
  const quarantinePath = uniqueSiblingPath(path, 'q');
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  }
  await assertDirectoryIdentity(
    dirname(path),
    parent,
    `IPC socket parent changed after applying private socket close shield: ${path}`,
  );
  const quarantined = await lstat(quarantinePath);
  return {
    path: quarantinePath,
    identity: { dev: quarantined.dev, ino: quarantined.ino, uid: quarantined.uid },
    changedDuringQuarantine: !matchesPathIdentity(quarantined, initial),
  };
}

async function restoreQuarantinedPathWithoutOverwrite(
  quarantined: QuarantinedPath,
  originalPath: string,
  parent: DirectoryIdentity,
): Promise<boolean> {
  await assertDirectoryIdentity(
    dirname(originalPath),
    parent,
    `IPC socket parent changed while restoring private socket close shield quarantine: ${originalPath}`,
  );
  const candidate = await lstat(quarantined.path);
  if (!matchesPathIdentity(candidate, quarantined.identity)) {
    throw new Error('IPC private socket close shield quarantine changed before restoration');
  }
  try {
    await link(quarantined.path, originalPath);
  } catch (error) {
    if (isFileError(error, 'EEXIST')) return false;
    throw error;
  }
  const restored = await lstat(originalPath);
  if (!matchesPathIdentity(restored, quarantined.identity)) {
    throw new Error('IPC private socket close shield restored an unexpected occupant');
  }
  await unlink(quarantined.path);
  return true;
}

async function unlinkVerifiedQuarantine(
  quarantined: QuarantinedPath,
  parent: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(
    dirname(quarantined.path),
    parent,
    `IPC socket parent changed while cleaning private socket close shield placeholder: ${quarantined.path}`,
  );
  const candidate = await lstat(quarantined.path);
  if (!matchesPathIdentity(candidate, quarantined.identity)) {
    throw new Error('IPC private socket close shield placeholder quarantine changed');
  }
  await unlink(quarantined.path);
}

function matchesPathIdentity(
  stat: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'uid'>,
  expected: SocketIdentity,
): boolean {
  return stat.uid === expected.uid && stat.dev === expected.dev && stat.ino === expected.ino;
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out while checking existing IPC socket: ${path}`));
    }, 250);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (isFileError(error, 'ECONNREFUSED') || isFileError(error, 'ENOENT')) resolve(false);
      else reject(error);
    });
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error); });
  });
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
