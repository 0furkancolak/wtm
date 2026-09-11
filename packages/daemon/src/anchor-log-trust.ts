import fs, { type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createWindowsFileTrustPolicy, readWindowsAclBatch, type WindowsAclBatchReader } from '@wtm/platform/trust';
import { retainedLogCount } from './log-policy';

export interface AnchorLogSpec {
  root: string;
  stdoutPath: string;
  stderrPath: string;
  launchMarkerPath: string;
  completionMarkerPath: string;
  rotationBytes: number;
  retainedFiles: number;
}

export interface AnchorLogStore {
  open(signal?: AbortSignal): Promise<{ stdout: Writable; stderr: Writable }>;
  publishLaunch(signal?: AbortSignal): Promise<void>;
  publishCompletion(value: unknown | (() => unknown)): Promise<void>;
  close(): Promise<void>;
}

interface Temporary { path: string; fd: number | null; stat: Stats }
const maxOperationPaths = 128;

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ANCHOR_LOG_OPERATION_ABORTED');
}

/**
 * All ACL evidence belongs to one bounded mutation. Empty exclusive temporary files are created
 * first so their own ACL, not an assumption about inherited permissions, can join the same batch.
 * After authorization, mutations are synchronous and each pathname remains pinned to its inode.
 */
class LogOperation {
  readonly #files = new Map<string, Stats | null>();
  readonly #directories = new Map<string, Stats>();
  readonly #temporaries: Temporary[] = [];
  readonly #unused: Temporary[] = [];
  readonly #signal: AbortSignal | undefined;
  readonly #windows: boolean;
  readonly #root: string;
  readonly #pins: Map<string, Stats>;

  constructor(root: string, windows: boolean, pins: Map<string, Stats>, signal?: AbortSignal) {
    this.#root = path.resolve(root); this.#windows = windows; this.#pins = pins; this.#signal = signal;
  }

  #directory(target: string): Stats {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (!this.#windows
      && ((stat.mode & 0o777) !== 0o700 || process.getuid?.() !== stat.uid))) throw new Error('UNSAFE_LOG_DIRECTORY');
    const expected = this.#pins.get(target);
    if (expected !== undefined && !sameIdentity(expected, stat)) throw new Error('LOG_DIRECTORY_CHANGED');
    return stat;
  }

  #file(target: string): Stats | null {
    try {
      const stat = fs.lstatSync(target);
      this.assertFileStat(stat);
      return stat;
    } catch (error) { if (absent(error)) return null; throw error; }
  }

  assertFileStat(stat: Stats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (!this.#windows
      && ((stat.mode & 0o077) !== 0 || process.getuid?.() !== stat.uid))) throw new Error('UNSAFE_LOG_TARGET');
  }

  add(target: string): void {
    assertActive(this.#signal);
    if (this.#files.has(target)) return;
    const relative = path.relative(this.#root, path.dirname(target));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('LOG_PATH_OUTSIDE_ROOT');
    let directory = this.#root;
    for (const part of [...(relative === '' ? [] : relative.split(path.sep)), '']) {
      if (!this.#directories.has(directory)) this.#directories.set(directory, this.#directory(directory));
      directory = path.join(directory, part);
    }
    this.#files.set(target, this.#file(target));
    if (this.#files.size + this.#directories.size > maxOperationPaths) throw new Error('ANCHOR_LOG_PATH_LIMIT');
  }

  prepareTemporaries(directory: string, count: number): void {
    for (let index = 0; index < count; index++) {
      this.verify();
      const target = path.join(directory, `.anchor-${process.pid}-${randomUUID()}.tmp`);
      const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND
        | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      let stat: Stats;
      try { stat = fs.fstatSync(fd); }
      catch (error) { fs.closeSync(fd); throw error; }
      const temporary = { path: target, fd, stat };
      this.#temporaries.push(temporary); this.#unused.push(temporary);
      this.add(target);
      this.assertFd(target, fd);
    }
  }

  async authorize(readBatch: WindowsAclBatchReader): Promise<void> {
    this.verify();
    if (this.#windows) {
      const paths = [...this.#directories.keys(), ...[...this.#files].flatMap(([target, stat]) => stat === null ? [] : [target])];
      const batch = await readBatch(paths, this.#signal === undefined ? {} : { signal: this.#signal });
      assertActive(this.#signal);
      this.verify();
      const policy = createWindowsFileTrustPolicy({ readAcl: async (target) => batch.acls.get(target),
        currentUserSid: async () => batch.currentSid });
      for (const [target, stat] of [...this.#directories, ...this.#files]) {
        if (stat === null) continue;
        if (!await policy.isOwnedByCurrentUser(stat, target) || !await policy.isWritableOnlyByOwner(stat, target, 0o077)) {
          throw new Error('UNSAFE_LOG_ACL');
        }
      }
    }
    this.verify();
    for (const [target, stat] of this.#directories) this.#pins.set(target, stat);
  }

  verify(): void {
    assertActive(this.#signal);
    for (const [target, stat] of this.#directories) {
      if (!sameIdentity(stat, this.#directory(target))) throw new Error('LOG_DIRECTORY_CHANGED');
    }
    for (const [target, expected] of this.#files) {
      const current = this.#file(target);
      if ((current === null) !== (expected === null)
        || (current !== null && expected !== null && !sameIdentity(current, expected))) throw new Error('LOG_FILE_CHANGED');
    }
    for (const temporary of this.#temporaries) {
      if (temporary.fd !== null) {
        const stat = fs.fstatSync(temporary.fd); this.assertFileStat(stat);
        if (!sameIdentity(stat, temporary.stat)) throw new Error('LOG_FILE_CHANGED');
      }
    }
  }

  assertFd(target: string, fd: number): Stats {
    this.verify();
    const stat = fs.fstatSync(fd); this.assertFileStat(stat);
    const expected = this.#files.get(target);
    if (expected === undefined || expected === null || !sameIdentity(expected, stat)) throw new Error('LOG_FILE_CHANGED');
    return stat;
  }

  has(target: string): boolean { this.verify(); return this.#files.get(target) != null; }
  size(target: string): number | null { this.verify(); return this.#file(target)?.size ?? null; }

  readMarker(target: string): string {
    if (!this.has(target)) return '0';
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = this.assertFd(target, fd);
      if (stat.size > 1024) throw new Error('INVALID_LOG_GENERATION_MARKER');
      const buffer = Buffer.alloc(1025);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      this.assertFd(target, fd);
      if (length > 1024) throw new Error('INVALID_LOG_GENERATION_MARKER');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).trim();
    } finally { fs.closeSync(fd); }
  }

  move(source: string, target: string): void {
    this.verify();
    const stat = this.#files.get(source);
    if (stat == null || !this.#files.has(target)) throw new Error('LOG_FILE_CHANGED');
    fs.renameSync(source, target);
    this.#files.set(source, null); this.#files.set(target, stat);
    this.verify();
  }

  remove(target: string): void {
    this.verify();
    if (!this.has(target)) return;
    fs.unlinkSync(target); this.#files.set(target, null); this.verify();
  }

  #takeTemporary(): Temporary {
    const temporary = this.#unused.shift();
    if (temporary === undefined || temporary.fd === null) throw new Error('ANCHOR_LOG_TEMPORARY_LIMIT');
    this.assertFd(temporary.path, temporary.fd);
    return temporary;
  }

  publish(target: string, value: string): void {
    const temporary = this.#takeTemporary();
    const fd = temporary.fd!;
    if (Buffer.byteLength(value, 'utf8') > 4096) throw new Error('ANCHOR_LOG_MARKER_LIMIT');
    fs.writeFileSync(fd, value); fs.fsyncSync(fd);
    this.assertFd(temporary.path, fd);
    this.move(temporary.path, target);
    fs.closeSync(fd); temporary.fd = null;
  }

  openCurrent(target: string): { fd: number; size: number } {
    if (!this.has(target)) {
      const temporary = this.#takeTemporary();
      this.move(temporary.path, target);
      const fd = temporary.fd!;
      const size = this.assertFd(target, fd).size;
      temporary.fd = null;
      return { fd, size };
    }
    const fd = fs.openSync(target, fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { return { fd, size: this.assertFd(target, fd).size }; }
    catch (error) { fs.closeSync(fd); throw error; }
  }

  dispose(): void {
    for (const temporary of this.#temporaries) {
      if (temporary.fd !== null) { try { fs.closeSync(temporary.fd); } catch { /* Already closed after an I/O failure. */ } }
      try {
        // Cleanup must never unlink a replacement path after a parent or temporary swap.
        for (const [target, stat] of this.#directories) {
          if (!sameIdentity(stat, this.#directory(target))) throw new Error('LOG_DIRECTORY_CHANGED');
        }
        const current = this.#file(temporary.path);
        if (current !== null && sameIdentity(current, temporary.stat)) fs.unlinkSync(temporary.path);
      } catch { /* Keep uncertain paths; no trusted content was written before authorization. */ }
    }
  }
}

function generation(marker: string, operation: LogOperation, target: string): number {
  if (/^\d+$/.test(marker) && Number.isSafeInteger(Number(marker))) return Number(marker);
  if (/^rotating-[A-Za-z0-9-]+$/.test(marker)) {
    return !operation.has(target) || operation.size(target) === 0 && operation.has(`${target}.1`) ? 1 : 0;
  }
  throw new Error('INVALID_LOG_GENERATION_MARKER');
}

type LogMutation = <T>(targets: readonly string[], temporaryCount: number, signal: AbortSignal | undefined,
  action: (operation: LogOperation) => T) => Promise<T>;

class RotatingLog extends Writable {
  #fd: number | null = null;
  #size = 0;
  #generation = 0;
  readonly #target: string;
  readonly #spec: AnchorLogSpec;
  readonly #signal: AbortSignal | undefined;
  readonly #mutate: LogMutation;
  readonly #verifyWriter: (target: string, fd: number) => void;

  constructor(target: string, spec: AnchorLogSpec, signal: AbortSignal | undefined,
    mutate: LogMutation, verifyWriter: (target: string, fd: number) => void) {
    super({ highWaterMark: 16 * 1024 });
    this.#target = target; this.#spec = spec; this.#signal = signal;
    this.#mutate = mutate; this.#verifyWriter = verifyWriter;
  }

  get targets(): string[] {
    return [this.#target, `${this.#target}.generation`, ...Array.from({ length: this.#spec.retainedFiles }, (_, i) => `${this.#target}.${i + 1}`)];
  }

  initialize(operation: LogOperation): void {
    const markerPath = `${this.#target}.generation`;
    const marker = operation.readMarker(markerPath);
    this.#generation = this.#recover(operation, marker);
    const opened = operation.openCurrent(this.#target);
    this.#fd = opened.fd; this.#size = opened.size;
    const phased = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-([A-Za-z0-9-]+)$/.exec(operation.readMarker(markerPath));
    if (phased !== null) operation.publish(markerPath, `rotating-${phased[1]}-opened-${phased[3]}`);
    operation.publish(markerPath, String(this.#generation));
  }

  #recover(operation: LogOperation, marker: string): number {
    const phased = /^rotating-(\d+)-(marker|closed|shifted|archived|opened)-([A-Za-z0-9-]+)$/.exec(marker);
    if (phased === null) return generation(marker, operation, this.#target);
    const currentGeneration = Number(phased[1]); const phase = phased[2]; const transaction = phased[3];
    if (!Number.isSafeInteger(currentGeneration) || currentGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('INVALID_LOG_GENERATION_MARKER');
    const archive = `${this.#target}.1`; const markerPath = `${this.#target}.generation`;
    if (phase === 'archived' || phase === 'opened') {
      if (!operation.has(archive) || phase === 'opened' && !operation.has(this.#target)) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
      return currentGeneration + 1;
    }
    if (!operation.has(this.#target)) {
      if (phase !== 'shifted' || !operation.has(archive)) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
      operation.publish(markerPath, `rotating-${currentGeneration}-archived-${transaction}`);
      return currentGeneration + 1;
    }
    if ((phase === 'marker' || phase === 'closed') && operation.size(this.#target) === 0
      || phase === 'shifted' && !operation.has(archive) && operation.size(this.#target) === 0) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
    if (phase === 'shifted' && operation.has(archive) && operation.size(this.#target) === 0) {
      operation.publish(markerPath, `rotating-${currentGeneration}-archived-${transaction}`);
      return currentGeneration + 1;
    }
    if (phase !== 'shifted') {
      const present = Array.from({ length: this.#spec.retainedFiles }, (_, i) => operation.has(`${this.#target}.${i + 1}`));
      const firstMissing = present.findIndex((value) => !value);
      const shiftStart = firstMissing < 0 ? this.#spec.retainedFiles - 1 : firstMissing;
      if (firstMissing < 0) operation.remove(`${this.#target}.${this.#spec.retainedFiles}`);
      for (let suffix = shiftStart; suffix >= 1; suffix--) {
        const source = `${this.#target}.${suffix}`; const target = `${this.#target}.${suffix + 1}`;
        if (!operation.has(source)) continue;
        if (operation.has(target)) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
        operation.move(source, target);
      }
      operation.publish(markerPath, `rotating-${currentGeneration}-shifted-${transaction}`);
    }
    if (operation.has(archive)) throw new Error('AMBIGUOUS_LOG_ROTATION_RECOVERY');
    operation.move(this.#target, archive);
    operation.publish(markerPath, `rotating-${currentGeneration}-archived-${transaction}`);
    return currentGeneration + 1;
  }

  async #rotate(): Promise<void> {
    await this.#mutate(this.targets, 7, this.#signal, (operation) => {
      if (this.destroyed || this.#fd === null) throw new Error('ANCHOR_LOG_CLOSED');
      this.#verifyWriter(this.#target, this.#fd);
      if (this.#generation >= Number.MAX_SAFE_INTEGER) throw new Error('INVALID_LOG_GENERATION_MARKER');
      const transaction = `${process.pid}-${randomUUID()}`; const marker = `${this.#target}.generation`;
      operation.publish(marker, `rotating-${this.#generation}-marker-${transaction}`);
      fs.closeSync(this.#fd); this.#fd = null;
      operation.publish(marker, `rotating-${this.#generation}-closed-${transaction}`);
      operation.remove(`${this.#target}.${this.#spec.retainedFiles}`);
      for (let suffix = this.#spec.retainedFiles - 1; suffix >= 1; suffix--) {
        const source = `${this.#target}.${suffix}`;
        if (operation.has(source)) operation.move(source, `${this.#target}.${suffix + 1}`);
      }
      operation.publish(marker, `rotating-${this.#generation}-shifted-${transaction}`);
      operation.move(this.#target, `${this.#target}.1`);
      operation.publish(marker, `rotating-${this.#generation}-archived-${transaction}`);
      const opened = operation.openCurrent(this.#target); this.#fd = opened.fd; this.#size = 0;
      operation.publish(marker, `rotating-${this.#generation}-opened-${transaction}`);
      this.#generation++;
      operation.publish(marker, String(this.#generation));
    });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      let offset = 0;
      while (offset < chunk.length) {
        assertActive(this.#signal);
        if (this.destroyed || this.#fd === null) throw new Error('ANCHOR_LOG_CLOSED');
        if (this.#size >= this.#spec.rotationBytes) await this.#rotate();
        assertActive(this.#signal);
        if (this.destroyed || this.#fd === null) throw new Error('ANCHOR_LOG_CLOSED');
        this.#verifyWriter(this.#target, this.#fd);
        const length = Math.min(chunk.length - offset, this.#spec.rotationBytes - this.#size);
        let written = 0;
        while (written < length) {
          const amount = fs.writeSync(this.#fd, chunk, offset + written, length - written);
          if (amount <= 0) throw new Error('ANCHOR_LOG_WRITE_FAILED');
          written += amount;
        }
        offset += length; this.#size += length;
      }
    })().then(() => callback(), (error: Error) => callback(error));
  }

  override _final(callback: (error?: Error | null) => void): void {
    try { if (this.#fd !== null) fs.closeSync(this.#fd); this.#fd = null; callback(); }
    catch (error) { callback(error as Error); }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try { if (this.#fd !== null) fs.closeSync(this.#fd); } catch { /* Preserve the original failure. */ }
    this.#fd = null; callback(error);
  }
}

export function createAnchorLogStore(platform: string, spec: AnchorLogSpec,
  options: { readAclBatch?: WindowsAclBatchReader } = {}): AnchorLogStore {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('UNSUPPORTED_ANCHOR_LOG_PLATFORM');
  if (!Number.isSafeInteger(spec.rotationBytes) || spec.rotationBytes < 1) throw new Error('ANCHOR_LOG_BOUND_INVALID');
  retainedLogCount(spec.retainedFiles);
  const windows = platform === 'win32';
  const pins = new Map<string, Stats>();
  const readBatch = options.readAclBatch ?? readWindowsAclBatch;
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  let streams: { stdout: RotatingLog; stderr: RotatingLog } | undefined;
  function mutate<T>(targets: readonly string[], temporaryCount: number, signal: AbortSignal | undefined,
    action: (operation: LogOperation) => T): Promise<T> {
    const result = pending.then(async () => {
      assertActive(signal);
      const operation = new LogOperation(spec.root, windows, pins, signal);
      try {
        for (const target of targets) operation.add(target);
        operation.prepareTemporaries(path.dirname(targets[0]!), temporaryCount);
        await operation.authorize(readBatch);
        assertActive(signal);
        return action(operation);
      } finally { operation.dispose(); }
    });
    pending = result.catch(() => {});
    return result;
  }
  function verifyWriter(target: string, fd: number): void {
    for (const [directory, expected] of pins) {
      const current = fs.lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)
        || (!windows && ((current.mode & 0o777) !== 0o700 || current.uid !== process.getuid?.()))) throw new Error('LOG_DIRECTORY_CHANGED');
    }
    const held = fs.fstatSync(fd); const current = fs.lstatSync(target);
    for (const stat of [held, current]) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (!windows && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('UNSAFE_LOG_TARGET');
    }
    if (!sameIdentity(held, current)) throw new Error('LOG_FILE_CHANGED');
  }
  async function publish(target: string, value: unknown | (() => unknown), signal?: AbortSignal): Promise<void> {
    await mutate([target], 1, signal, (operation) => {
      operation.publish(target, JSON.stringify(typeof value === 'function' ? value() : value));
    });
  }
  return {
    async open(signal) {
      if (closed || streams !== undefined) throw new Error('ANCHOR_LOG_CLOSED');
      const stdout = new RotatingLog(spec.stdoutPath, spec, signal, mutate, verifyWriter);
      const stderr = new RotatingLog(spec.stderrPath, spec, signal, mutate, verifyWriter);
      streams = { stdout, stderr };
      try {
        await mutate([...stdout.targets, ...stderr.targets], 14, signal, (operation) => {
          if (closed) throw new Error('ANCHOR_LOG_CLOSED');
          stdout.initialize(operation); stderr.initialize(operation);
        });
        return streams;
      } catch (error) { stdout.destroy(); stderr.destroy(); throw error; }
    },
    async publishLaunch(signal) { await publish(spec.launchMarkerPath, { pid: process.pid }, signal); },
    async publishCompletion(value) { await publish(spec.completionMarkerPath, value); },
    async close() {
      closed = true; streams?.stdout.destroy(); streams?.stderr.destroy(); await pending;
    },
  };
}
