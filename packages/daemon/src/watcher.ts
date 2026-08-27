import { createHash } from 'node:crypto';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconcileSignal } from './reconciler-queue';

export interface RepositoryWatchRegistration {
  mainRoot: string;
  commonGitDir: string;
  worktreePaths: readonly string[];
}

export interface WorkspaceWatchRegistration {
  workspaceRoot: string;
  repositories: readonly RepositoryWatchRegistration[];
}

type WatchRole = 'content' | 'git-admin';
type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

export interface WatchHandle {
  close(): void;
  onError(listener: (error: Error) => void): () => void;
}

export interface FingerprintDirectory {
  read(): Promise<Dirent | null>;
  close(): Promise<void>;
}

export type FingerprintDirectoryFactory = (path: string) => Promise<FingerprintDirectory>;

export interface StructuralWatcherOptions {
  registrations: readonly WorkspaceWatchRegistration[];
  schedule(signal: ReconcileSignal): void;
  watchFactory?: (
    root: string,
    options: { recursive: true },
    listener: WatchListener,
  ) => WatchHandle;
  fingerprint?: (root: string, roles: ReadonlySet<WatchRole>) => Promise<string>;
  directoryFactory?: FingerprintDirectoryFactory;
  onError?: (error: unknown) => void;
}

interface WatchedRoot {
  root: string;
  roles: Set<WatchRole>;
  fingerprint: string;
  handle: WatchHandle | null;
  unsubscribeError: (() => void) | null;
  fingerprintRunning: Promise<void> | null;
  fingerprintDirty: boolean;
}

const manifestNames = new Set([
  'Cargo.lock', 'Cargo.toml', 'Dockerfile', 'Makefile', 'bun.lock', 'bun.lockb',
  'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml',
  'go.mod', 'go.sum', 'package-lock.json', 'package.json', 'pnpm-lock.yaml',
  'pyproject.toml', 'requirements.txt', 'uv.lock', 'yarn.lock',
]);
const configNames = new Set(['.node-version', '.nvmrc', '.tool-versions', 'wtm.toml']);

export class StructuralWatcher {
  readonly #roots: WatchedRoot[];
  readonly #schedule: StructuralWatcherOptions['schedule'];
  readonly #watchFactory: NonNullable<StructuralWatcherOptions['watchFactory']>;
  readonly #fingerprint: NonNullable<StructuralWatcherOptions['fingerprint']>;
  readonly #onError: (error: unknown) => void;
  readonly #inFlight = new Set<Promise<void>>();
  #state: 'idle' | 'starting' | 'started' | 'closing' | 'closed' = 'idle';
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: StructuralWatcherOptions) {
    this.#roots = collectWatchedRoots(options.registrations);
    this.#schedule = options.schedule;
    this.#watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.#fingerprint = options.fingerprint ?? ((root, roles) => structuralFingerprint(root, roles, {
      ...(options.directoryFactory === undefined ? {} : { directoryFactory: options.directoryFactory }),
    }));
    this.#onError = options.onError ?? (() => {});
  }

  start(): Promise<void> {
    if (this.#state === 'started') return Promise.resolve();
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#state === 'closing' || this.#state === 'closed') {
      return Promise.reject(new Error('Structural watcher is closed'));
    }
    this.#state = 'starting';
    this.#startPromise = this.#start().finally(() => { this.#startPromise = null; });
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    const opened: WatchedRoot[] = [];
    try {
      for (const watched of this.#roots) {
        watched.fingerprint = await this.#fingerprint(watched.root, watched.roles);
        if (this.#state !== 'starting') {
          this.#closeRoots(opened);
          return;
        }
        watched.handle = this.#watchFactory(
          watched.root,
          { recursive: true },
          (_eventType, filename) => this.#signal(watched, filename),
        );
        opened.push(watched);
        watched.unsubscribeError = watched.handle.onError((error) => this.#watchError(watched, error));
      }
      if (this.#state === 'starting') this.#state = 'started';
    } catch (error) {
      try {
        this.#closeRoots(opened);
      } catch (cleanupError) {
        this.#safeOnError(cleanupError);
      }
      if (this.#state === 'starting') this.#state = 'idle';
      throw error;
    }
  }

  async whenIdle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#state === 'closed') return Promise.resolve();
    this.#state = 'closing';
    this.#closePromise = this.#close().finally(() => {
      this.#state = 'closed';
      this.#closePromise = null;
    });
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    let failure: unknown;
    try {
      try {
        this.#closeRoots(this.#roots);
      } catch (error) {
        failure ??= error;
      }
      await this.#startPromise;
    } catch (error) {
      failure ??= error;
    }
    try {
      this.#closeRoots(this.#roots);
    } catch (error) {
      failure ??= error;
    }
    try {
      await this.whenIdle();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  #signal(watched: WatchedRoot, filename: string | Buffer | null): void {
    if (this.#state === 'closing' || this.#state === 'closed') return;
    if (filename === null) {
      this.#requestFingerprint(watched);
      return;
    }
    const path = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
    const kind = classifyStructuralPath(path, watched.roles);
    if (kind !== null) this.#safeSchedule({ root: watched.root, kind });
  }

  #requestFingerprint(watched: WatchedRoot): void {
    if (watched.fingerprintRunning !== null) {
      watched.fingerprintDirty = true;
      return;
    }
    const comparison = this.#runFingerprint(watched);
    watched.fingerprintRunning = comparison;
    this.#inFlight.add(comparison);
    void comparison.finally(() => {
      if (watched.fingerprintRunning === comparison) watched.fingerprintRunning = null;
      this.#inFlight.delete(comparison);
    });
  }

  async #runFingerprint(watched: WatchedRoot): Promise<void> {
    do {
      watched.fingerprintDirty = false;
      try {
        const next = await this.#fingerprint(watched.root, watched.roles);
        if (this.#state !== 'closing' && this.#state !== 'closed' && next !== watched.fingerprint) {
          watched.fingerprint = next;
          this.#safeSchedule({ root: watched.root, kind: 'fingerprint' });
        }
      } catch (error) {
        this.#safeOnError(error);
      }
    } while (watched.fingerprintDirty && this.#state !== 'closing' && this.#state !== 'closed');
  }

  #watchError(watched: WatchedRoot, error: Error): void {
    if (this.#state === 'closing' || this.#state === 'closed') return;
    this.#safeOnError(error);
    try {
      this.#closeRoots([watched]);
    } catch (cleanupError) {
      this.#safeOnError(cleanupError);
    }
    this.#safeSchedule({ root: watched.root, kind: 'watch-error' });
  }

  #safeSchedule(signal: ReconcileSignal): void {
    try {
      this.#schedule(signal);
    } catch (error) {
      this.#safeOnError(error);
    }
  }

  #safeOnError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Observer failures must not escape an fs.watch callback.
    }
  }

  #closeRoots(roots: readonly WatchedRoot[]): void {
    let failure: unknown;
    for (const watched of [...roots].reverse()) {
      const unsubscribe = watched.unsubscribeError;
      watched.unsubscribeError = null;
      try {
        unsubscribe?.();
      } catch (error) {
        failure ??= error;
      }
      const handle = watched.handle;
      watched.handle = null;
      try {
        handle?.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}

function collectWatchedRoots(registrations: readonly WorkspaceWatchRegistration[]): WatchedRoot[] {
  const rolesByRoot = new Map<string, Set<WatchRole>>();
  const add = (root: string, role: WatchRole) => {
    const roles = rolesByRoot.get(root) ?? new Set<WatchRole>();
    roles.add(role);
    rolesByRoot.set(root, roles);
  };
  for (const workspace of registrations) {
    add(workspace.workspaceRoot, 'content');
    for (const repository of workspace.repositories) {
      add(repository.mainRoot, 'content');
      add(repository.commonGitDir, 'git-admin');
      for (const worktreePath of repository.worktreePaths) add(worktreePath, 'content');
    }
  }
  return [...rolesByRoot]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, roles]) => ({
      root,
      roles,
      fingerprint: '',
      handle: null,
      unsubscribeError: null,
      fingerprintRunning: null,
      fingerprintDirty: false,
    }));
}

function classifyStructuralPath(path: string, roles: ReadonlySet<WatchRole>): ReconcileSignal['kind'] | null {
  if (roles.has('git-admin')) return 'git-topology';
  const segments = path.replaceAll('\\', '/').split('/');
  if (segments.includes('.git')) return 'git-topology';
  const name = segments.at(-1) ?? '';
  if (configNames.has(name)) return 'config';
  if (manifestNames.has(name)) return 'manifest';
  return null;
}

export async function structuralFingerprint(
  root: string,
  roles: ReadonlySet<WatchRole>,
  options: { directoryFactory?: FingerprintDirectoryFactory } = {},
): Promise<string> {
  const entries: string[] = [];
  const directoryFactory = options.directoryFactory ?? defaultDirectoryFactory;
  if (roles.has('git-admin')) {
    for (const name of ['HEAD', 'config', 'packed-refs']) {
      await fingerprintPath(join(root, name), name, entries, true);
    }
    await fingerprintLooseRefs(root, entries, directoryFactory);
    await fingerprintLinkedWorktrees(root, entries, directoryFactory);
  } else {
    for (const name of [...new Set(['.git', ...configNames, ...manifestNames])].sort()) {
      await fingerprintPath(join(root, name), name, entries, true);
    }
  }
  return entries.join('|');
}

const fingerprintReadLimit = 4096;
const fingerprintEntryLimit = 1024;
const fingerprintDepthLimit = 6;
const worktreeEntryLimit = 256;

async function fingerprintLooseRefs(
  root: string,
  entries: string[],
  directoryFactory: FingerprintDirectoryFactory,
): Promise<void> {
  const refsRoot = join(root, 'refs');
  let count = 0;
  let truncated = false;
  async function visit(path: string, label: string, depth: number): Promise<void> {
    if (count >= fingerprintEntryLimit || depth > fingerprintDepthLimit) {
      truncated = true;
      return;
    }
    let sample: DirectorySample;
    try {
      sample = await readDirectorySample(path, fingerprintEntryLimit - count, directoryFactory);
    } catch (error) {
      if (isFileError(error, 'ENOENT')) {
        entries.push(`${label}:missing`);
        return;
      }
      throw error;
    }
    if (sample.truncated) truncated = true;
    for (const child of sample.names) {
      if (count >= fingerprintEntryLimit) {
        truncated = true;
        break;
      }
      count += 1;
      const childPath = join(path, child);
      const childLabel = `${label}/${child}`;
      const stat = await lstat(childPath);
      if (stat.isDirectory()) {
        if (depth >= fingerprintDepthLimit) {
          entries.push(`${childLabel}:depth-limit`);
          truncated = true;
        } else {
          await visit(childPath, childLabel, depth + 1);
        }
      }
      else await fingerprintPath(childPath, childLabel, entries, true, stat);
    }
  }
  await visit(refsRoot, 'refs', 0);
  entries.push(`refs:count=${count}`);
  if (truncated) entries.push('refs:truncated');
}

async function fingerprintLinkedWorktrees(
  root: string,
  entries: string[],
  directoryFactory: FingerprintDirectoryFactory,
): Promise<void> {
  const worktreesRoot = join(root, 'worktrees');
  let sample: DirectorySample;
  try {
    sample = await readDirectorySample(worktreesRoot, worktreeEntryLimit, directoryFactory);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) {
      entries.push('worktrees:missing');
      return;
    }
    throw error;
  }
  entries.push(`worktrees:children=${sample.names.join(',')}`);
  if (sample.truncated) entries.push('worktrees:truncated');
  for (const child of sample.names) {
    for (const name of ['HEAD', 'gitdir', 'index', 'locked', 'prunable']) {
      await fingerprintPath(
        join(worktreesRoot, child, name),
        `worktrees/${child}/${name}`,
        entries,
        true,
      );
    }
  }
}

interface DirectorySample {
  names: string[];
  truncated: boolean;
}

async function readDirectorySample(
  path: string,
  limit: number,
  directoryFactory: FingerprintDirectoryFactory,
): Promise<DirectorySample> {
  const directory = await directoryFactory(path);
  const names: string[] = [];
  let truncated = false;
  try {
    for (let index = 0; index < limit; index += 1) {
      const entry = await directory.read();
      if (entry === null) return { names: names.sort(), truncated: false };
      names.push(entry.name);
    }
    truncated = await directory.read() !== null;
    return { names: names.sort(), truncated };
  } finally {
    await directory.close();
  }
}

async function defaultDirectoryFactory(path: string): Promise<FingerprintDirectory> {
  return await opendir(path);
}

async function fingerprintPath(
  path: string,
  label: string,
  entries: string[],
  includeContent: boolean,
  knownStat?: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  let stat = knownStat;
  try {
    stat ??= await lstat(path);
  } catch (error) {
    if (isFileError(error, 'ENOENT')) {
      entries.push(`${label}:missing`);
      return;
    }
    throw error;
  }
  const kind = stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : 'o';
  let digest = '';
  if (includeContent && stat.isFile()) digest = `:${await boundedDigest(path)}`;
  entries.push(`${label}:${kind}:${stat.mode}:${stat.size}:${stat.mtimeMs}${digest}`);
}

async function boundedDigest(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(fingerprintReadLimit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex').slice(0, 16);
  } finally {
    await handle.close();
  }
}

function defaultWatchFactory(
  root: string,
  options: { recursive: true },
  listener: WatchListener,
): WatchHandle {
  const watcher: FSWatcher = watch(root, options, listener);
  return {
    close: () => watcher.close(),
    onError: (errorListener) => {
      watcher.on('error', errorListener);
      return () => watcher.off('error', errorListener);
    },
  };
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export const structuralWatchMarkerNames = Object.freeze([
  ...configNames,
  ...manifestNames,
].sort());
