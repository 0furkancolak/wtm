import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Stats } from 'node:fs';
import type { AdapterTrustInput, AdapterTrustRecord, AdapterTrustStateStore } from '../state/store';
import { ensurePrivateDirectory, PrivateDirectoryError, verifyPrivateDirectory } from '../state/private-directory';

const maxAdapterBytes = 8 * 1024 * 1024;
const inheritedAdapterDescriptor = 3;

export type { AdapterTrustRecord } from '../state/store';

export interface AdapterExecutableIdentity {
  canonicalPath: string;
  sha256: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface TrustedAdapterDescriptor {
  /** Child-side descriptor number, inherited as a read-only copy of the verified bytes. */
  readonly childDescriptor: number;
  /** Parent descriptor passed to child_process after its private pathname was unlinked. */
  readonly parentDescriptor: number;
  /** Original executable basename exposed by the V1 descriptor runner. */
  readonly executableBasename: string;
  close(): Promise<void>;
}

export interface AdapterTrustStore {
  list(): readonly AdapterTrustRecord[];
  upsert(input: AdapterTrustInput): Promise<AdapterTrustRecord>;
}

export interface TrustRepositoryAdapterInput {
  adapterId: string;
  executablePath: string;
}

export class AdapterTrustError extends Error {
  readonly code = 'ADAPTER_NOT_TRUSTED' as const;
  readonly severity = 'error' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AdapterTrustError';
  }
}

export function createAdapterTrustStore(records: readonly AdapterTrustRecord[] = []): AdapterTrustStore {
  let current = normalizeRecords(records);
  return {
    list: () => current,
    upsert: async (input) => {
      const record = normalizeRecords([{ ...input, trustedAt: new Date().toISOString() }])[0]!;
      current = normalizeRecords([
        ...current.filter((candidate) =>
          candidate.adapterId !== record.adapterId || candidate.canonicalPath !== record.canonicalPath),
        record,
      ]);
      return record;
    },
  };
}

export function createSqliteAdapterTrustStore(store: AdapterTrustStateStore): AdapterTrustStore {
  return {
    list: () => store.listAdapterTrust(),
    upsert: async (input) => store.upsertAdapterTrust(input),
  };
}

export async function trustRepositoryAdapter(
  store: AdapterTrustStore,
  input: TrustRepositoryAdapterInput,
): Promise<AdapterTrustRecord> {
  assertAdapterId(input.adapterId);
  const identity = await inspectAdapterExecutable(input.executablePath);
  return store.upsert({
    adapterId: input.adapterId,
    canonicalPath: identity.canonicalPath,
    sha256: identity.sha256,
  });
}

export async function verifyTrustedRepositoryAdapter(
  store: AdapterTrustStore,
  input: TrustRepositoryAdapterInput,
): Promise<AdapterExecutableIdentity> {
  assertAdapterId(input.adapterId);
  const source = await readSafeAdapterSource(input.executablePath);
  assertTrusted(store, input.adapterId, source.identity);
  return source.identity;
}

/**
 * Copies the bytes hashed and matched to the trust record into a private file,
 * reopens it read-only, and unlinks it before returning. The caller keeps that
 * anonymous descriptor open until the child has completed.
 */
export async function openTrustedAdapterDescriptor(
  store: AdapterTrustStore,
  input: TrustRepositoryAdapterInput,
): Promise<TrustedAdapterDescriptor> {
  assertAdapterId(input.adapterId);
  const source = await openSafeAdapterSource(input.executablePath);
  let sourceClosed = false;
  try {
    assertTrusted(store, input.adapterId, source.identity);
    await source.handle.close();
    sourceClosed = true;
    const executable = await createAnonymousTrustedAdapter(source.bytes);
    let closed = false;
    return {
      childDescriptor: inheritedAdapterDescriptor,
      parentDescriptor: executable.fd,
      executableBasename: basename(source.identity.canonicalPath),
      close: async () => {
        if (closed) return;
        closed = true;
        await executable.close();
      },
    };
  } catch (error) {
    if (!sourceClosed) await source.handle.close().catch(() => {});
    throw error;
  }
}

export async function inspectAdapterExecutable(executablePath: string): Promise<AdapterExecutableIdentity> {
  return (await readSafeAdapterSource(executablePath)).identity;
}

async function readSafeAdapterSource(executablePath: string): Promise<{
  bytes: Buffer;
  identity: AdapterExecutableIdentity;
}> {
  const source = await openSafeAdapterSource(executablePath);
  try {
    return { bytes: source.bytes, identity: source.identity };
  } finally {
    await source.handle.close();
  }
}

async function openSafeAdapterSource(executablePath: string): Promise<{
  bytes: Buffer;
  identity: AdapterExecutableIdentity;
  handle: FileHandle;
}> {
  if (executablePath.trim() === '') throw new AdapterTrustError('External adapter executable path is invalid.');
  const canonicalPath = await realpath(executablePath).catch(() => {
    throw new AdapterTrustError('External adapter executable is unavailable.');
  });
  const before = await lstat(canonicalPath).catch(() => {
    throw new AdapterTrustError('External adapter executable is unavailable.');
  });
  assertSafeAdapterFile(before);

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new AdapterTrustError('External adapter executable is unavailable.');
  });
  try {
    const opened = await handle.stat().catch(() => {
      throw new AdapterTrustError('External adapter executable is unavailable.');
    });
    assertSafeAdapterFile(opened);
    if (!sameFile(before, opened)) {
      throw new AdapterTrustError('External adapter executable changed during verification.');
    }
    const bytes = await readBounded(handle, opened.size);
    const afterHandle = await handle.stat().catch(() => {
      throw new AdapterTrustError('External adapter executable is unavailable.');
    });
    const afterPath = await lstat(canonicalPath).catch(() => {
      throw new AdapterTrustError('External adapter executable is unavailable.');
    });
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) {
      throw new AdapterTrustError('External adapter executable changed during verification.');
    }
    assertExactV1AdapterDeclaration(bytes);
    return {
      bytes,
      identity: {
        canonicalPath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        device: opened.dev,
        inode: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
      },
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readBounded(handle: FileHandle, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxAdapterBytes) {
    throw new AdapterTrustError('External adapter executable is invalid.');
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) throw new AdapterTrustError('External adapter executable changed during verification.');
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    throw new AdapterTrustError('External adapter executable changed during verification.');
  }
  return bytes;
}

async function createAnonymousTrustedAdapter(bytes: Buffer): Promise<FileHandle> {
  let directoryPath: string | undefined;
  let executablePath: string | undefined;
  let writer: FileHandle | undefined;
  let reader: FileHandle | undefined;
  try {
    directoryPath = await mkdtemp(join(tmpdir(), 'wtm-adapter-execution-'));
    const directory = await ensurePrivateDirectory(directoryPath);
    directoryPath = directory.path;
    executablePath = join(directory.path, 'adapter.mjs');
    writer = await open(
      executablePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await writeAll(writer, bytes);
    await writer.sync();
    const written = await writer.stat();
    assertPrivateExecutionFile(written, bytes.length);
    await writer.close();
    writer = undefined;

    await verifyPrivateDirectory(directory);
    reader = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await reader.stat();
    assertPrivateExecutionFile(opened, bytes.length);
    if (!sameFile(written, opened) || !(await readBounded(reader, bytes.length)).equals(bytes)) {
      throw new AdapterTrustError('External adapter private execution copy is invalid.');
    }

    await verifyPrivateDirectory(directory);
    await unlink(executablePath);
    executablePath = undefined;
    const unlinked = await reader.stat();
    if (unlinked.nlink !== 0 || unlinked.dev !== opened.dev || unlinked.ino !== opened.ino) {
      throw new AdapterTrustError('External adapter private execution copy is invalid.');
    }
    await verifyPrivateDirectory(directory);
    await rmdir(directory.path);
    directoryPath = undefined;

    const result = reader;
    reader = undefined;
    return result;
  } catch (error) {
    if (error instanceof AdapterTrustError) throw error;
    if (error instanceof PrivateDirectoryError) {
      throw new AdapterTrustError('External adapter private execution directory is unsafe.');
    }
    throw new AdapterTrustError('External adapter private execution copy is unavailable.');
  } finally {
    await writer?.close().catch(() => {});
    await reader?.close().catch(() => {});
    if (executablePath !== undefined) await unlink(executablePath).catch(() => {});
    if (directoryPath !== undefined) await rmdir(directoryPath).catch(() => {});
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new AdapterTrustError('External adapter private execution copy is unavailable.');
    offset += bytesWritten;
  }
}

function assertPrivateExecutionFile(stat: Stats, size: number): void {
  const currentUserId = process.getuid?.();
  if (
    !stat.isFile()
    || currentUserId === undefined
    || stat.uid !== currentUserId
    || stat.nlink !== 1
    || stat.size !== size
    || (stat.mode & 0o177) !== 0
  ) {
    throw new AdapterTrustError('External adapter private execution copy is invalid.');
  }
}

function assertTrusted(store: AdapterTrustStore, adapterId: string, identity: AdapterExecutableIdentity): void {
  const trusted = store.list().some((record) =>
    record.adapterId === adapterId
    && record.canonicalPath === identity.canonicalPath
    && record.sha256 === identity.sha256);
  if (!trusted) throw new AdapterTrustError('Repository-local external adapter is not trusted.');
}

function assertSafeAdapterFile(stat: Stats): void {
  if (!stat.isFile()) throw new AdapterTrustError('External adapter executable is invalid.');
  const currentUserId = process.getuid?.();
  if (currentUserId === undefined || stat.uid !== currentUserId) {
    throw new AdapterTrustError('External adapter executable is not owned by the current user.');
  }
  if (stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
    throw new AdapterTrustError('External adapter executable has unsafe permissions.');
  }
  if ((stat.mode & 0o111) === 0) {
    throw new AdapterTrustError('External adapter executable is not executable.');
  }
}

function assertExactV1AdapterDeclaration(bytes: Buffer): void {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AdapterTrustError('External adapter executable format is unsupported.');
  }
  const [hashbang, declaration] = source.split(/\r?\n/u, 3);
  if (hashbang !== '#!/usr/bin/env node' || declaration !== '// wtm-adapter-v1: self-contained') {
    throw new AdapterTrustError('External adapter executable format is unsupported.');
  }
}

function normalizeRecords(records: readonly AdapterTrustRecord[]): AdapterTrustRecord[] {
  const normalized = new Map<string, AdapterTrustRecord>();
  for (const record of records) {
    assertAdapterId(record.adapterId);
    if (
      record.canonicalPath.length === 0
      || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || Number.isNaN(Date.parse(record.trustedAt))
    ) {
      throw new AdapterTrustError('External adapter trust record is invalid.');
    }
    normalized.set(`${record.adapterId}\0${record.canonicalPath}`, {
      adapterId: record.adapterId,
      canonicalPath: record.canonicalPath,
      sha256: record.sha256,
      trustedAt: record.trustedAt,
    });
  }
  return [...normalized.values()].sort((left, right) =>
    left.adapterId.localeCompare(right.adapterId) || left.canonicalPath.localeCompare(right.canonicalPath));
}

function assertAdapterId(adapterId: string): void {
  if (adapterId.trim() === '') throw new AdapterTrustError('External adapter identifier is invalid.');
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}
