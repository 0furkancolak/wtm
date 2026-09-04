import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';

const defaultRotationBytes = 20 * 1024 * 1024;
const defaultRetainedFiles = 3;

/**
 * The default `FileTrustPolicy`, for a caller who does not inject one — every current caller of
 * `ManagedLogStore`, until a composition root threads its own `PlatformRuntime.fileTrust` through.
 * Resolved on first use rather than at import, mirroring `process-supervisor.ts`'s own
 * `hostPlatformRuntime`: a module-level `selectPlatformRuntime()` would make merely importing this
 * file throw on a platform WTM has no backend for, a refusal a caller could no longer catch and
 * report as an envelope.
 */
let selectedFileTrust: FileTrustPolicy | null = null;

function hostFileTrustPolicy(): FileTrustPolicy {
  selectedFileTrust ??= selectPlatformRuntime().fileTrust;
  return selectedFileTrust;
}

export interface ManagedLogStoreOptions {
  root: string;
  rotationBytes?: number;
  retainedFiles?: number;
  rotationCheckMs?: number;
  /** Defaults to the host platform's own policy — see `hostFileTrustPolicy` above. */
  fileTrust?: FileTrustPolicy;
  onError?: (error: unknown) => void;
  raceHook?: (
    phase: 'after-open' | 'after-read-open' | 'before-rotate-operation' | 'during-cursor-read'
      | 'after-generation-read' | 'before-cursor-segment-open',
    path: string,
  ) => void | Promise<void>;
}

export interface OpenedManagedLogs {
  stdoutPath: string;
  stderrPath: string;
  stdout: FileHandle;
  stderr: FileHandle;
  close(): Promise<void>;
  /** Rotation is owned by the detached anchor. Kept as a no-op compatibility hook. */
  maintain(): Promise<void>;
}

export interface PreparedManagedLogs {
  root: string;
  stdoutPath: string;
  stderrPath: string;
  launchMarkerPath: string;
  rotationBytes: number;
  retainedFiles: number;
}

export interface ManagedLogCursor {
  dev: number;
  ino: number;
  offset: number;
  rotated: boolean;
  truncated: boolean;
  generation: string;
}

export interface ManagedLogCursorRead {
  content: string;
  cursor: ManagedLogCursor;
}

export class ManagedLogStore {
  readonly #root: string;
  readonly #rotationBytes: number;
  readonly #retainedFiles: number;
  readonly #raceHook: NonNullable<ManagedLogStoreOptions['raceHook']>;
  readonly #fileTrust: FileTrustPolicy;

  constructor(options: ManagedLogStoreOptions) {
    if (!isAbsolute(options.root)) throw new TypeError('Managed log root must be absolute');
    this.#root = resolve(options.root);
    this.#rotationBytes = positiveInteger(options.rotationBytes ?? defaultRotationBytes, 'Log rotation size');
    this.#retainedFiles = positiveInteger(options.retainedFiles ?? defaultRetainedFiles, 'Retained log count');
    positiveInteger(options.rotationCheckMs ?? 250, 'Log rotation check interval');
    this.#raceHook = options.raceHook ?? (() => {});
    this.#fileTrust = options.fileTrust ?? hostFileTrustPolicy();
  }

  async open(worktreeId: string, taskName: string): Promise<OpenedManagedLogs> {
    return await this.#open(worktreeId, taskName, true);
  }

  async prepare(worktreeId: string, taskName: string): Promise<PreparedManagedLogs> {
    const opened = await this.#open(worktreeId, taskName, false);
    await opened.close();
    const launchMarkerPath = join(resolve(opened.stdoutPath, '..'), 'launch.json');
    const directory = resolve(launchMarkerPath, '..');
    const parent = await directoryIdentity(directory, this.#fileTrust);
    if (await safeLogStat(launchMarkerPath, this.#fileTrust) !== null) {
      await assertDirectoryIdentity(directory, parent, this.#fileTrust);
      await rm(launchMarkerPath);
      await assertDirectoryIdentity(directory, parent, this.#fileTrust);
    }
    return {
      root: this.#root,
      stdoutPath: opened.stdoutPath,
      stderrPath: opened.stderrPath,
      launchMarkerPath,
      rotationBytes: this.#rotationBytes,
      retainedFiles: this.#retainedFiles,
    };
  }

  async #open(worktreeId: string, taskName: string, rotateBeforeOpen: boolean): Promise<OpenedManagedLogs> {
    assertSafeIdentifier(worktreeId);
    assertSafeIdentifier(taskName);
    await secureDirectory(this.#root, this.#fileTrust);
    const directory = join(this.#root, worktreeId, taskName);
    await secureChildDirectory(this.#root, join(this.#root, worktreeId), this.#fileTrust);
    await secureChildDirectory(join(this.#root, worktreeId), directory, this.#fileTrust);
    const stdoutPath = join(directory, 'stdout.log');
    const stderrPath = join(directory, 'stderr.log');
    if (rotateBeforeOpen) {
      await this.#rotateIfNeeded(stdoutPath);
      await this.#rotateIfNeeded(stderrPath);
    }

    const parentIdentity = await directoryIdentity(directory, this.#fileTrust);
    const stdout = await openSafeLog(stdoutPath, this.#fileTrust);
    let stderr: FileHandle;
    try {
      await this.#raceHook('after-open', stdoutPath);
      await assertDirectoryIdentity(directory, parentIdentity, this.#fileTrust);
      stderr = await openSafeLog(stderrPath, this.#fileTrust);
      await this.#raceHook('after-open', stderrPath);
      await assertDirectoryIdentity(directory, parentIdentity, this.#fileTrust);
    } catch (error) {
      await stdout.close();
      throw error;
    }
    let closed = false;
    const maintain = async () => {};
    return {
      stdoutPath,
      stderrPath,
      stdout,
      stderr,
      maintain,
      close: async () => {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([closeFileHandle(stdout), closeFileHandle(stderr)]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      },
    };
  }

  async recover(stdoutPath: string, stderrPath: string): Promise<void> {
    const stdout = resolve(stdoutPath);
    const stderr = resolve(stderrPath);
    assertContained(this.#root, stdout);
    assertContained(this.#root, stderr);
    const stdoutParts = relative(this.#root, stdout).split(sep);
    const stderrParts = relative(this.#root, stderr).split(sep);
    if (
      stdoutParts.length !== 3 || stderrParts.length !== 3
      || stdoutParts[0] !== stderrParts[0] || stdoutParts[1] !== stderrParts[1]
      || stdoutParts[2] !== 'stdout.log' || stderrParts[2] !== 'stderr.log'
    ) throw new Error('Unsafe managed log recovery path');
    const directory = resolve(stdout, '..');
    await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
    const parent = await directoryIdentity(directory, this.#fileTrust);
    for (const path of [stdout, stderr]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assertSafeFileHandle(handle, path, this.#fileTrust);
        await assertDirectoryIdentity(directory, parent, this.#fileTrust);
      } finally {
        await handle.close();
      }
    }
  }

  async hasLaunchAcknowledgement(stdoutPath: string, pid: number): Promise<boolean> {
    const stdout = resolve(stdoutPath);
    assertContained(this.#root, stdout);
    const directory = resolve(stdout, '..');
    await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
    const parent = await directoryIdentity(directory, this.#fileTrust);
    const marker = join(directory, 'launch.json');
    let handle: FileHandle;
    try { handle = await openExistingSafeLog(marker, this.#fileTrust); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    try {
      const stat = await handle.stat();
      if (stat.size > 128) return false;
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      await assertDirectoryIdentity(directory, parent, this.#fileTrust);
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        && 'pid' in value && value.pid === pid;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    } finally {
      await handle.close();
    }
  }

  async close(): Promise<void> {
    // Anchors own their descriptors and continue independently of the daemon.
  }

  async read(path: string, maxBytes = 1024 * 1024): Promise<string> {
    positiveInteger(maxBytes, 'Managed log read bound');
    const absolute = resolve(path);
    assertContained(this.#root, absolute);
    const rootPath = await realpath(this.#root);
    const targetPath = await realpath(absolute);
    assertContained(rootPath, targetPath);
    const directory = resolve(absolute, '..');
    await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
    const parentIdentity = await directoryIdentity(directory, this.#fileTrust);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await this.#raceHook('after-read-open', absolute);
      await assertDirectoryIdentity(directory, parentIdentity, this.#fileTrust);
      await assertSafeFileHandle(handle, absolute, this.#fileTrust);
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      if (length === 0) return '';
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async readCursor(
    path: string,
    cursor?: Pick<ManagedLogCursor, 'dev' | 'ino' | 'offset'> & { generation?: string },
    maxBytes = 1024 * 1024,
  ): Promise<ManagedLogCursorRead> {
    positiveInteger(maxBytes, 'Managed log read bound');
    const absolute = resolve(path);
    assertContained(this.#root, absolute);
    const directory = resolve(absolute, '..');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
      const parentIdentity = await directoryIdentity(directory, this.#fileTrust);
      const before = await readGenerationMarker(absolute, this.#fileTrust);
      await this.#raceHook('after-generation-read', absolute);
      let result: ManagedLogCursorRead;
      try {
        const rotation = before.startsWith('rotating-')
          ? await resolveRotationSnapshot(absolute, before, cursor?.generation, this.#fileTrust)
          : null;
        result = rotation !== null && cursor !== undefined
          ? await this.#readRotatingCursor(absolute, cursor, maxBytes, parentIdentity)
            ?? await this.#readCursorGeneration(
              absolute, String(rotation.generation), cursor, maxBytes, parentIdentity, rotation.currentPath,
            )
          : await this.#readCursorGeneration(
            absolute,
            rotation === null ? before : String(rotation.generation),
            cursor,
            maxBytes,
            parentIdentity,
            rotation?.currentPath ?? absolute,
          );
      } catch (error) {
        const afterFailure = await readGenerationMarker(absolute, this.#fileTrust);
        await assertDirectoryIdentity(directory, parentIdentity, this.#fileTrust);
        if (before !== afterFailure || isMissing(error)) { await shortYield(); continue; }
        throw error;
      }
      await this.#raceHook('during-cursor-read', absolute);
      const after = await readGenerationMarker(absolute, this.#fileTrust);
      await assertDirectoryIdentity(directory, parentIdentity, this.#fileTrust);
      if (before === after) return result;
      await shortYield();
    }
    throw new Error('Managed log rotated during bounded read');
  }

  async #readRotatingCursor(
    path: string,
    cursor: Pick<ManagedLogCursor, 'dev' | 'ino' | 'offset'> & { generation?: string },
    maxBytes: number,
    parentIdentity: DirectoryIdentity,
  ): Promise<ManagedLogCursorRead | null> {
    for (let suffix = 0; suffix <= this.#retainedFiles; suffix += 1) {
      const candidate = suffix === 0 ? path : `${path}.${suffix}`;
      let handle: FileHandle;
      await this.#raceHook('before-cursor-segment-open', candidate);
      try { handle = await openExistingSafeLog(candidate, this.#fileTrust); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      try {
        const stat = await handle.stat();
        if (stat.dev !== cursor.dev || stat.ino !== cursor.ino) continue;
        if (cursor.offset > stat.size) throw new Error('Managed log cursor exceeds its rotation segment');
        const length = Math.min(stat.size - cursor.offset, maxBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = length === 0
          ? { bytesRead: 0 }
          : await handle.read(buffer, 0, length, cursor.offset);
        await assertDirectoryIdentity(resolve(path, '..'), parentIdentity, this.#fileTrust);
        const content = buffer.subarray(0, bytesRead);
        const emittedBytes = completeUtf8PrefixLength(content);
        return {
          content: content.subarray(0, emittedBytes).toString('utf8'),
          cursor: {
            dev: stat.dev,
            ino: stat.ino,
            offset: cursor.offset + emittedBytes,
            rotated: suffix !== 0,
            truncated: false,
            generation: cursor.generation ?? '0',
          },
        };
      } finally {
        await handle.close().catch(() => {});
      }
    }
    return null;
  }

  async #readCursorGeneration(
    path: string,
    currentGeneration: string,
    cursor: (Pick<ManagedLogCursor, 'dev' | 'ino' | 'offset'> & { generation?: string }) | undefined,
    maxBytes: number,
    parentIdentity: DirectoryIdentity,
    currentPath: string,
  ): Promise<ManagedLogCursorRead> {
    const currentNumber = parseGeneration(currentGeneration);
    const cursorNumber = cursor?.generation === undefined ? currentNumber : parseGeneration(cursor.generation);
    let difference = Math.max(0, currentNumber - cursorNumber);
    let truncated = false;
    if (difference > this.#retainedFiles) {
      difference = this.#retainedFiles;
      truncated = true;
    }
    let source = difference === 0 ? currentPath : `${path}.${difference}`;
    let handle: FileHandle;
    await this.#raceHook('before-cursor-segment-open', source);
    try { handle = await openExistingSafeLog(source, this.#fileTrust); }
    catch (error) {
      if (!isMissing(error)) throw error;
      difference = 0;
      source = currentPath;
      handle = await openExistingSafeLog(source, this.#fileTrust);
      truncated = true;
    }
    let stat = await handle.stat();
    let rotated = cursor !== undefined && difference !== 0;
    let position: number;
    if (cursor === undefined) position = Math.max(0, stat.size - maxBytes);
    else if (stat.dev === cursor.dev && stat.ino === cursor.ino && cursor.offset <= stat.size) position = cursor.offset;
    else {
      rotated = true;
      truncated = true;
      await handle.close();
      difference = 0;
      source = currentPath;
      handle = await openExistingSafeLog(source, this.#fileTrust);
      stat = await handle.stat();
      position = Math.max(0, stat.size - maxBytes);
    }
    const chunks: Buffer[] = [];
    let remaining = maxBytes;
    try {
      while (true) {
        const length = Math.min(Math.max(0, stat.size - position), remaining);
        if (length > 0) {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead > 0) {
            chunks.push(buffer.subarray(0, bytesRead));
            position += bytesRead;
            remaining -= bytesRead;
          }
        }
        if (remaining === 0 || position < stat.size || difference === 0) break;
        await handle.close();
        difference -= 1;
        source = difference === 0 ? currentPath : `${path}.${difference}`;
        handle = await openExistingSafeLog(source, this.#fileTrust);
        stat = await handle.stat();
        position = 0;
        rotated = true;
      }
      await assertDirectoryIdentity(resolve(path, '..'), parentIdentity, this.#fileTrust);
      const content = Buffer.concat(chunks);
      const emittedBytes = completeUtf8PrefixLength(content);
      const withheldBytes = content.byteLength - emittedBytes;
      position -= withheldBytes;
      return {
        content: content.subarray(0, emittedBytes).toString('utf8'),
        cursor: {
          dev: stat.dev,
          ino: stat.ino,
          offset: position,
          rotated,
          truncated,
          generation: String(currentNumber - difference),
        },
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async rotate(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      const absolute = resolve(path);
      assertContained(this.#root, absolute);
      await this.#rotateIfNeeded(absolute);
    }
  }

  async #rotateIfNeeded(path: string): Promise<void> {
    const directory = resolve(path, '..');
    await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
    const parent = await directoryIdentity(directory, this.#fileTrust);
    await this.#raceHook('before-rotate-operation', path);
    await assertSecureDirectoryChain(this.#root, directory, this.#fileTrust);
    await assertDirectoryIdentity(directory, parent, this.#fileTrust);
    const stat = await safeLogStat(path, this.#fileTrust);
    if (stat === null || stat.size < this.#rotationBytes) return;

    await assertDirectoryIdentity(directory, parent, this.#fileTrust);
    await this.#shiftGenerations(path, directory, parent);
    await assertDirectoryIdentity(directory, parent, this.#fileTrust);
    await rename(path, `${path}.1`);
    await assertDirectoryIdentity(directory, parent, this.#fileTrust);
  }

  async #shiftGenerations(path: string, directory: string, parent: DirectoryIdentity): Promise<void> {
    const oldest = `${path}.${this.#retainedFiles}`;
    if (await safeLogStat(oldest, this.#fileTrust) !== null) {
      await assertDirectoryIdentity(directory, parent, this.#fileTrust);
      await rm(oldest);
      await assertDirectoryIdentity(directory, parent, this.#fileTrust);
    }
    for (let generation = this.#retainedFiles - 1; generation >= 1; generation -= 1) {
      const source = `${path}.${generation}`;
      if (await safeLogStat(source, this.#fileTrust) !== null) {
        await assertDirectoryIdentity(directory, parent, this.#fileTrust);
        await rename(source, `${path}.${generation + 1}`);
        await assertDirectoryIdentity(directory, parent, this.#fileTrust);
      }
    }
  }
}

/**
 * `secureDirectory`, `secureChildDirectory` and `directoryIdentity` used to reimplement "is this
 * directory mine" as `process.getuid?.()` compared against `stat.uid` — a no-op on Windows, where
 * `process.getuid` does not exist, which is why an unowned or shared directory was never refused
 * there. `isOwnedByCurrentUser` is the same question asked through the port, and
 * `!fileTrust.currentIdentityAvailable()` failing closed (rather than the old `uid === undefined`
 * silently skipping the check) is what makes a Windows `FileTrustPolicy` actually run this at all.
 */
async function isOwnedDirectory(stat: Stats, path: string, fileTrust: FileTrustPolicy): Promise<boolean> {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !fileTrust.currentIdentityAvailable()) return false;
  return fileTrust.isOwnedByCurrentUser(stat, path);
}

async function secureDirectory(path: string, fileTrust: FileTrustPolicy): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!(await isOwnedDirectory(stat, path, fileTrust))) {
    throw new Error('Unsafe managed log directory');
  }
  await chmod(path, 0o700);
}

async function secureChildDirectory(parent: string, path: string, fileTrust: FileTrustPolicy): Promise<void> {
  const parentBefore = await directoryIdentity(parent, fileTrust);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!isExists(error)) throw error; }
  await assertDirectoryIdentity(parent, parentBefore, fileTrust);
  const stat = await lstat(path);
  if (!(await isOwnedDirectory(stat, path, fileTrust))) {
    throw new Error('Unsafe managed log directory');
  }
  await chmod(path, 0o700);
}

interface DirectoryIdentity { dev: number; ino: number; uid: number }

/**
 * `directoryIdentity` is called after `secureDirectory`/`secureChildDirectory` have already
 * `chmod`-ed the directory to exactly `0o700`, so unlike those two it also re-asks the mode
 * question — as `isWritableOnlyByOwner(stat, path, 0o077)`, "no group/other access at all", the
 * same mask `assertPrivateDirectory` (`@wtm/core`'s directory-shaped analogue, migrated in the
 * same Windows-trust increment) uses rather than a raw `(stat.mode & 0o777) !== 0o700` equality:
 * that equality was the check unconditionally false on Windows (`fs.Stats.mode` there never
 * reflects a POSIX `chmod`), and the port's mask asks the same "did anyone loosen this since I
 * secured it" question in a way a Windows `Get-Acl` read can actually answer.
 */
async function directoryIdentity(path: string, fileTrust: FileTrustPolicy): Promise<DirectoryIdentity> {
  const stat = await lstat(path);
  const unsafe = !(await isOwnedDirectory(stat, path, fileTrust))
    || !(await fileTrust.isWritableOnlyByOwner(stat, path, 0o077));
  if (unsafe) throw new Error('Unsafe managed log directory');
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

async function assertSecureDirectoryChain(root: string, directory: string, fileTrust: FileTrustPolicy): Promise<void> {
  const rootPath = resolve(root);
  const target = resolve(directory);
  assertContained(rootPath, target);
  await directoryIdentity(rootPath, fileTrust);
  const child = relative(rootPath, target);
  if (child === '') return;
  let current = rootPath;
  for (const part of child.split(sep)) {
    current = join(current, part);
    await directoryIdentity(current, fileTrust);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  fileTrust: FileTrustPolicy,
): Promise<void> {
  const current = await directoryIdentity(path, fileTrust);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.uid !== expected.uid) {
    throw new Error('Managed log directory identity changed');
  }
}

async function openSafeLog(path: string, fileTrust: FileTrustPolicy): Promise<FileHandle> {
  const existing = await safeLogStat(path, fileTrust);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink() || !fileTrust.isNotSharedByHardLink(existing))) {
    throw new Error('Unsafe managed log target');
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new Error('Unsafe managed log target', { cause: error });
  }
  try {
    await assertSafeFileHandle(handle, path, fileTrust);
    await handle.chmod(0o600);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openExistingSafeLog(path: string, fileTrust: FileTrustPolicy): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertSafeFileHandle(handle, path, fileTrust);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function safeLogStat(path: string, fileTrust: FileTrustPolicy): Promise<Stats | null> {
  try {
    const stat = await lstat(path);
    const unsafe = !stat.isFile()
      || stat.isSymbolicLink()
      || !fileTrust.isNotSharedByHardLink(stat)
      || !fileTrust.currentIdentityAvailable()
      || !(await fileTrust.isOwnedByCurrentUser(stat, path));
    if (unsafe) throw new Error('Unsafe managed log target');
    return stat;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readGenerationMarker(path: string, fileTrust: FileTrustPolicy): Promise<string> {
  const marker = `${path}.generation`;
  let handle: FileHandle;
  try { handle = await openExistingSafeLog(marker, fileTrust); }
  catch (error) { if (isMissing(error)) return '0'; throw error; }
  try {
    const stat = await handle.stat();
    if (stat.size > 128) throw new Error('Invalid managed log generation marker');
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (/^\d+$/.test(value) || /^rotating-[A-Za-z0-9-]+$/.test(value)) return value;
    throw new Error('Invalid managed log generation marker');
  } finally {
    await handle.close();
  }
}

async function resolveRotationSnapshot(
  path: string,
  marker: string,
  cursorGeneration: string | undefined,
  fileTrust: FileTrustPolicy,
): Promise<{ generation: number; currentPath: string }> {
  const structured = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-[A-Za-z0-9-]+$/.exec(marker);
  let generation: number;
  let archived: boolean;
  if (structured !== null) {
    generation = parseGeneration(structured[1] as string);
    archived = structured[2] === 'archived' || structured[2] === 'opened';
  } else {
    // Versions before the phase protocol did not record the base generation.
    // A cursor supplies it exactly. For an initial tail, zero is the only
    // generation that can be proven from the legacy marker itself.
    generation = cursorGeneration === undefined ? 0 : parseGeneration(cursorGeneration);
    const current = await safeLogStat(path, fileTrust);
    const first = await safeLogStat(`${path}.1`, fileTrust);
    archived = first !== null && (current === null || current.size === 0);
  }
  let currentPath = archived ? `${path}.1` : path;
  if (await safeLogStat(currentPath, fileTrust) === null) {
    const fallback = currentPath === path ? `${path}.1` : path;
    if (await safeLogStat(fallback, fileTrust) === null) throw new Error('Managed log rotation has no readable segment');
    currentPath = fallback;
  }
  return { generation, currentPath };
}

function parseGeneration(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('Invalid managed log generation marker');
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid managed log generation marker');
  return generation;
}

function shortYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (buffer.byteLength === 0) return 0;
  let lead = buffer.byteLength - 1;
  while (lead >= 0 && (Number(buffer[lead]) & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const byte = Number(buffer[lead]);
  const expected = (byte & 0x80) === 0 ? 1
    : (byte & 0xe0) === 0xc0 ? 2
      : (byte & 0xf0) === 0xe0 ? 3
        : (byte & 0xf8) === 0xf0 ? 4 : 1;
  return buffer.byteLength - lead < expected ? lead : buffer.byteLength;
}

async function assertSafeFileHandle(handle: FileHandle, path: string, fileTrust: FileTrustPolicy): Promise<void> {
  const stat = await handle.stat();
  const unsafe = !stat.isFile()
    || !fileTrust.isNotSharedByHardLink(stat)
    || !fileTrust.currentIdentityAvailable()
    || !(await fileTrust.isOwnedByCurrentUser(stat, path));
  if (unsafe) throw new Error('Unsafe managed log target');
}

function assertSafeIdentifier(value: string): void {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('Unsafe managed log identifier');
  }
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return;
  throw new Error('Requested path is outside managed log root');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

async function closeFileHandle(handle: FileHandle): Promise<void> {
  try { await handle.close(); }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EBADF') throw error;
  }
}
