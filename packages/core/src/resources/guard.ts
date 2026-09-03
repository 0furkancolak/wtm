import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultCoreFileTrustPolicy, type FileTrustPolicy } from '../file-trust-policy';
import { runGit } from '../git/git-runner';

export type ResourceGuardIntent = 'write' | 'delete' | 'publish' | 'symlink-target' | 'read-source';

export interface GitTrackingInspector {
  isTracked(repositoryRoot: string, repositoryRelativePath: string): Promise<boolean>;
  administrativePaths?(repositoryRoot: string): Promise<readonly string[]>;
}

export interface ResourceGuardOptions {
  sandboxRoot: string;
  workspaceRoot: string;
  repositoryRoots?: readonly string[];
  gitDirectoryPaths?: readonly string[];
  homeDirectory?: string;
  fileTrust?: FileTrustPolicy;
  git?: GitTrackingInspector;
}

interface PathIdentity {
  dev: number;
  ino: number;
  uid: number;
}

/**
 * A live reference to one filesystem object, held so that the question "is this still the object
 * I inspected?" has an answer.
 *
 * `(dev, ino, uid)` is the whole of the identity `lstat` offers, and comparing it across time is a
 * proof of sameness only for as long as the inode number cannot be handed to something else. On
 * APFS that happens to hold -- a deleted inode number is never reissued -- and every check-then-use
 * defence in this repository was written, and passed, on that accident. ext4 and tmpfs reissue it
 * immediately, so `rm(p)` followed by a create at `p` produces an object this comparison calls
 * identical. The first Linux CI run (33648234137) turned six tests red on exactly that: the
 * service publisher's uninstall removed the replacement it was written to preserve, the sandbox
 * guard accepted a swapped parent, and the GC deleted a file that had been substituted under it.
 * `daemon/src/__tests__/inode-reuse-measurement.test.ts` measures both halves on whichever
 * platform runs -- it sits there rather than here because spec D8 forbids this package from
 * knowing which platform that is -- so this paragraph is a fact the suite re-checks, not an
 * inference.
 *
 * An open descriptor answers it, by two independent mechanisms whose blind spots do not overlap:
 *
 *  - **The number cannot be reissued while the pin is held.** The kernel does not free an inode
 *    that a descriptor still references, so a replacement created at the same path is forced to
 *    take a different number, and the `(dev, ino, uid)` comparison becomes true again. This is why
 *    the fix repairs the 57 comparison sites in `service-lifecycle.ts` without editing one of
 *    them: they were never the defect. The defect was that an `lstat` snapshot is a *description*
 *    of an object, and descriptions are forgeable; a descriptor is a *reference*.
 *  - **`fstat` reports `nlink === 0` once the object is unlinked**, which says the object is gone
 *    without inferring it from a number at all.
 *
 * `holds` requires both because each covers the other's platform blind spot, measured, not
 * assumed: darwin never clears `nlink` on a descriptor whose *directory* has been removed (it
 * still reads 2 after `rmdir`), so the second mechanism is file-only there; and on Linux the first
 * mechanism is the one doing the work whenever a racer recreates at the same path. Folding both
 * into one predicate is also what makes the fix falsifiable on macOS: the tuple comparison lives
 * here and nowhere else at the boundaries that use a pin, so breaking `holds` turns those tests
 * red on this machine instead of only on the runner.
 *
 * Rejected on the way here: widening the tuple with `birthtimeMs` or `ctimeMs`. Linux stamps both
 * from `current_time()`, which reads a clock updated once per tick, so a delete and a recreate
 * microseconds apart share a timestamp -- the cheap fix would have been one that silently does not
 * work on the only platform that needs it.
 */
export interface InodePin {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  /** Whether `current`, freshly read from the pinned path, is still the pinned object. */
  holds(current: { dev: number | bigint; ino: number | bigint; uid: number | bigint } | null): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Pins whatever `path` names right now, or returns `null` if that is nothing this can hold.
 *
 * `O_NOFOLLOW` so a symlink swapped in is refused rather than pinned through to its destination,
 * and `O_NONBLOCK` so a FIFO left at the path cannot park the open until someone opens the other
 * end -- a check that hangs fails no more safely than one that answers wrongly. A caller that gets
 * `null` has already lost the object it meant to hold and must deny; it never means "no pin
 * needed".
 */
export async function pinInode(path: string): Promise<InodePin | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isFileError(error, 'ENOENT') || isFileError(error, 'ELOOP') || isFileError(error, 'ENOTDIR')) return null;
    throw error;
  }
  try {
    const pinned = await handle.stat();
    const dev = Number(pinned.dev);
    const ino = Number(pinned.ino);
    const uid = Number(pinned.uid);
    return {
      dev,
      ino,
      uid,
      async holds(current) {
        if (current === null) return false;
        if (Number(current.dev) !== dev || Number(current.ino) !== ino || Number(current.uid) !== uid) return false;
        return Number((await handle.stat()).nlink) !== 0;
      },
      async close() { await handle.close().catch(() => {}); },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export interface ResourcePathAuthorization {
  readonly path: string;
  readonly intent: ResourceGuardIntent;
  readonly sandbox: PathIdentity;
  readonly parentPath: string;
  readonly parent: PathIdentity;
  /**
   * Which of this guard's pins on `parentPath` vouched for this authorization.
   *
   * A path can be legitimately re-pinned -- the GC removes its own quarantine containers and a
   * later `authorize` under the same parent must be allowed to hold whatever is there now. Without
   * this, a re-pin would hand the *old* token a *new* pin to be revalidated against, and on a
   * filesystem that reissues inode numbers the two would compare equal. Naming the pin is what
   * keeps `authorize` from quietly re-vouching for a capability it never issued.
   */
  readonly parentPin: number;
  readonly leaf?: PathIdentity;
}

export interface ResourceGuard {
  readonly sandboxRoot: string;
  authorize(path: string, intent: ResourceGuardIntent): Promise<ResourcePathAuthorization>;
  authorizeParent(path: string, intent: ResourceGuardIntent): Promise<ResourcePathAuthorization>;
  revalidateParent(authorization: ResourcePathAuthorization): Promise<void>;
  revalidate(authorization: ResourcePathAuthorization): Promise<ResourcePathAuthorization>;
}

export class ResourcePathGuardError extends Error {
  readonly severity = 'error' as const;

  constructor(
    readonly code: 'RESOURCE_PATH_DENIED' | 'RESOURCE_TRACKED_FILE_PROTECTED',
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ResourcePathGuardError';
  }
}

const unresolvedPathSyntax = /[$*?{}]/;

const resolvedVoid = Promise.resolve();

export async function createResourceGuard(options: ResourceGuardOptions): Promise<ResourceGuard> {
  assertResolvedAbsolutePath(options.sandboxRoot, 'sandboxRoot');
  assertResolvedAbsolutePath(options.workspaceRoot, 'workspaceRoot');
  const requestedSandboxRoot = resolve(options.sandboxRoot);
  const sandboxRoot = await canonicalDirectory(options.sandboxRoot, 'sandboxRoot');
  const workspaceRoot = await canonicalExistingOrResolved(options.workspaceRoot);
  const homeDirectory = await canonicalExistingOrResolved(options.homeDirectory ?? homedir());
  const repositoryRoots = await Promise.all(
    (options.repositoryRoots ?? [workspaceRoot]).map(canonicalExistingOrResolved),
  );
  const git = options.git ?? controlledGitTrackingInspector;
  const configuredGitDirectoryPaths = await Promise.all(
    (options.gitDirectoryPaths ?? []).map(canonicalExistingOrResolved),
  );
  const discoveredGitDirectoryPaths = git.administrativePaths === undefined
    ? []
    : (await Promise.all(repositoryRoots.map((root) => git.administrativePaths?.(root) ?? []))).flat();
  const gitDirectoryPaths = await Promise.all(
    [...configuredGitDirectoryPaths, ...discoveredGitDirectoryPaths].map(canonicalExistingOrResolved),
  );
  const fileTrust = options.fileTrust ?? defaultCoreFileTrustPolicy;
  if (!fileTrust.currentIdentityAvailable()) deny('The current user identity is unavailable.', { sandboxRoot });
  if (
    sandboxRoot === resolve('/')
    || sandboxRoot === homeDirectory
    || sandboxRoot === workspaceRoot
    || repositoryRoots.includes(sandboxRoot)
  ) {
    deny('The configured resource sandbox is too broad.', { sandboxRoot });
  }
  const sandboxStat = await lstat(sandboxRoot);
  await assertSafeDirectory(sandboxRoot, sandboxStat, fileTrust);
  const sandboxIdentity = identity(sandboxStat);

  /**
   * One pin per directory this guard has vouched for, keyed by path.
   *
   * An authorization is a capability that says "at time T, this path sat under this parent, and
   * that parent was safe". Nothing but a live reference makes that statement re-checkable later --
   * see `InodePin` -- so the guard holds one for every directory it has answered about, and
   * `revalidateParent` answers from the pin rather than from a second `lstat`.
   *
   * Keyed by path, so the cost is one descriptor per distinct directory a guard touches and not
   * one per `authorize` call: a GC sweep of a thousand objects under one parent holds one. Guards
   * are built per command and per operation, and the descriptors go with them.
   */
  const directoryPins = new Map<string, { readonly id: number; readonly pin: InodePin }>();
  const pinChain = new Map<string, Promise<void>>();
  let nextPinId = 1;

  const sandboxPin = await pinInode(sandboxRoot);
  if (sandboxPin === null || !await sandboxPin.holds(sandboxStat)) {
    deny('The configured resource sandbox could not be held for inspection.', { sandboxRoot });
  }

  /**
   * Pins `path`, or reuses the pin already held for it.
   *
   * A cached pin is only reused once it has agreed with what is on disk now. A directory this
   * guard vouched for earlier may legitimately be gone -- the GC removes its own quarantine
   * containers -- and re-pinning is the right answer there; refusing would fail closed on the
   * product's own housekeeping, which is its own outage.
   */
  const pinDirectory = (path: string, expected: PathIdentity): Promise<number> => {
    // Serialized per path. Two `authorize` calls for siblings under one parent run concurrently in
    // this codebase (`planResourceMaterialization` is fanned out with `Promise.all`), and an
    // unserialized cache check would let both miss, both pin, and the loser's token carry a pin id
    // the map no longer holds -- a refusal on the guard's own bookkeeping rather than on anything
    // that happened to the directory.
    const previous = pinChain.get(path) ?? resolvedVoid;
    const next = previous.then(() => pinDirectoryExclusively(path, expected));
    pinChain.set(path, next.then(() => undefined, () => undefined));
    return next;
  };

  const pinDirectoryExclusively = async (path: string, expected: PathIdentity): Promise<number> => {
    const cached = directoryPins.get(path);
    if (cached !== undefined) {
      if (cached.pin.dev === expected.dev && cached.pin.ino === expected.ino && await cached.pin.holds(expected)) {
        return cached.id;
      }
      directoryPins.delete(path);
      await cached.pin.close();
    }
    const pin = await pinInode(path);
    if (pin === null || !await pin.holds(expected)) {
      await pin?.close();
      deny('A resource parent changed while it was being authorized.', { path });
    }
    const id = nextPinId++;
    directoryPins.set(path, { id, pin });
    return id;
  };

  const authorize = async (
    requestedPath: string,
    intent: ResourceGuardIntent,
    parentOnly = false,
  ): Promise<ResourcePathAuthorization> => {
    assertResolvedAbsolutePath(requestedPath, 'path');
    const requested = resolve(requestedPath);
    const path = contains(requestedSandboxRoot, requested)
      ? resolve(sandboxRoot, relative(requestedSandboxRoot, requested))
      : requested;
    assertProtectedBoundaries(path, {
      sandboxRoot,
      workspaceRoot,
      homeDirectory,
      repositoryRoots,
      gitDirectoryPaths,
    });
    await assertSandboxIdentity(sandboxRoot, sandboxIdentity, fileTrust, sandboxPin);

    const leaf = await inspectExistingComponents(sandboxRoot, path, fileTrust);
    if (!parentOnly && leaf !== undefined && !leaf.isFile() && !leaf.isDirectory()) {
      deny('Special files are not valid resource mutation leaves.', { path });
    }
    if (
      !parentOnly && leaf !== undefined && intent !== 'read-source' && leaf.isFile()
      && !fileTrust.isNotSharedByHardLink(leaf)
    ) {
      deny('A hardlinked resource leaf is not safe to mutate.', { path, links: leaf.nlink });
    }
    await assertNotTracked(path, repositoryRoots, git);
    const parent = await nearestExistingDirectory(path, sandboxRoot, fileTrust);
    const parentPin = await pinDirectory(parent.path, identity(parent.stat));
    return {
      path,
      intent,
      sandbox: sandboxIdentity,
      parentPath: parent.path,
      parent: identity(parent.stat),
      parentPin,
      ...(leaf === undefined ? {} : { leaf: identity(leaf) }),
    };
  };

  const revalidateParent = async (token: ResourcePathAuthorization): Promise<void> => {
    if (token.sandbox.dev !== sandboxIdentity.dev || token.sandbox.ino !== sandboxIdentity.ino) {
      deny('The sandbox capability does not belong to this guard.', { path: token.path });
    }
    await assertSandboxIdentity(sandboxRoot, sandboxIdentity, fileTrust, sandboxPin);
    const parent = await lstat(token.parentPath).catch(() => null);
    if (parent !== null && !parent.isDirectory()) {
      deny('A resource parent changed after authorization.', { path: token.path, parent: token.parentPath });
    }
    // The identity comparison lives inside the pin and nowhere else here. A second `lstat`
    // comparison beside it would be the weaker half of the same question -- and would have kept
    // this test green on macOS while the guard accepted a swapped parent on Linux.
    const held = directoryPins.get(token.parentPath);
    if (held === undefined || held.id !== token.parentPin
      || held.pin.dev !== token.parent.dev || held.pin.ino !== token.parent.ino
      || !await held.pin.holds(parent)) {
      deny('A resource parent was replaced after authorization.', { path: token.path, parent: token.parentPath });
    }
  };

  return {
    sandboxRoot,
    authorize,
    async authorizeParent(path, intent) {
      return authorize(path, intent, true);
    },
    revalidateParent,
    async revalidate(token) {
      await revalidateParent(token);
      return authorize(token.path, token.intent);
    },
  };
}

export async function authorizeResourcePath(
  options: ResourceGuardOptions,
  path: string,
  intent: ResourceGuardIntent,
): Promise<ResourcePathAuthorization> {
  return (await createResourceGuard(options)).authorize(path, intent);
}

const controlledGitTrackingInspector: GitTrackingInspector = {
  async isTracked(repositoryRoot, repositoryRelativePath) {
    const result = await runGit(repositoryRoot, [
      '--literal-pathspecs', 'ls-files', '-z', '--', repositoryRelativePath,
    ]);
    if (result.stdout.length > 0) return true;
    const parts = repositoryRelativePath.split(sep);
    const ancestors = parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join(sep));
    if (ancestors.length === 0) return false;
    const staged = await runGit(repositoryRoot, [
      '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', ...ancestors,
    ]);
    return staged.stdout.toString('utf8').split('\0').some((record) => record.startsWith('160000 '));
  },
  async administrativePaths(repositoryRoot) {
    const [gitDirectory, commonDirectory] = await Promise.all([
      runGit(repositoryRoot, ['rev-parse', '--absolute-git-dir']),
      runGit(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    return [
      gitDirectory.stdout.toString('utf8').trim(),
      commonDirectory.stdout.toString('utf8').trim(),
    ].filter(Boolean);
  },
};

function assertResolvedAbsolutePath(path: string, field: string): void {
  if (
    path.trim() !== path
    || path.length === 0
    || !isAbsolute(path)
    || unresolvedPathSyntax.test(path)
    || path.split(sep).includes('..')
  ) {
    deny('Resource paths must be resolved absolute paths without environment or glob syntax.', { field, path });
  }
}

async function canonicalDirectory(path: string, field: string): Promise<string> {
  const canonical = await realpath(path).catch(() => deny('The configured resource sandbox must exist.', { field, path }));
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) deny('The configured resource sandbox must be a directory.', { field, path });
  return canonical;
}

async function canonicalExistingOrResolved(path: string): Promise<string> {
  assertResolvedAbsolutePath(path, 'protectedPath');
  return realpath(path).catch(() => resolve(path));
}

function assertProtectedBoundaries(
  path: string,
  protectedPaths: {
    sandboxRoot: string;
    workspaceRoot: string;
    homeDirectory: string;
    repositoryRoots: readonly string[];
    gitDirectoryPaths: readonly string[];
  },
): void {
  if (!containsStrict(protectedPaths.sandboxRoot, path)) {
    deny('The resource path is outside the configured sandbox.', { path, sandboxRoot: protectedPaths.sandboxRoot });
  }
  if (
    path === resolve('/')
    || path === protectedPaths.homeDirectory
    || path === protectedPaths.workspaceRoot
    || protectedPaths.repositoryRoots.includes(path)
  ) {
    deny('The resource path names a protected broad directory.', { path });
  }
  if (path.split(sep).includes('.git')) {
    deny('Git administrative paths are protected.', { path });
  }
  for (const gitDirectory of protectedPaths.gitDirectoryPaths) {
    if (path === gitDirectory || contains(gitDirectory, path) || contains(path, gitDirectory)) {
      deny('Git administrative paths are protected.', { path, gitDirectory });
    }
  }
}

async function inspectExistingComponents(
  sandboxRoot: string,
  path: string,
  fileTrust: FileTrustPolicy,
) {
  await assertNoNestedGitMarker(sandboxRoot, path);
  const nested = relative(sandboxRoot, path);
  const parts = nested.split(sep).filter(Boolean);
  let current = sandboxRoot;
  let leaf: Awaited<ReturnType<typeof lstat>> | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index] as string);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (isFileError(error, 'ENOENT')) break;
      throw error;
    }
    if (stat.isSymbolicLink()) deny('Symbolic links are not permitted in guarded resource paths.', { path, component: current });
    if (index < parts.length - 1) await assertSafeDirectory(current, stat, fileTrust);
    if (stat.isDirectory()) await assertNoNestedGitMarker(current, path);
    if (index === parts.length - 1) leaf = stat;
  }
  return leaf;
}

async function assertNoNestedGitMarker(directory: string, guardedPath: string): Promise<void> {
  const present = await lstat(resolve(directory, '.git')).then(() => true).catch((error) => {
    if (isFileError(error, 'ENOENT')) return false;
    throw error;
  });
  if (present) deny('Nested repository and submodule paths are protected.', { path: guardedPath, repository: directory });
}

async function nearestExistingDirectory(path: string, sandboxRoot: string, fileTrust: FileTrustPolicy) {
  let candidate = resolve(path, '..');
  while (contains(sandboxRoot, candidate)) {
    try {
      const stat = await lstat(candidate);
      await assertSafeDirectory(candidate, stat, fileTrust);
      return { path: candidate, stat };
    } catch (error) {
      if (!isFileError(error, 'ENOENT')) throw error;
    }
    if (candidate === sandboxRoot) break;
    candidate = resolve(candidate, '..');
  }
  deny('No safe existing resource parent was found.', { path });
}

async function assertSafeDirectory(
  path: string,
  stat: Awaited<ReturnType<typeof lstat>>,
  fileTrust: FileTrustPolicy,
): Promise<void> {
  if (!stat.isDirectory() || stat.isSymbolicLink()) deny('A resource parent is not a real directory.', { path });
  if (!(await fileTrust.isOwnedByCurrentUser(stat, path))) {
    deny('A resource parent is not owned by the current user.', { path, uid: stat.uid });
  }
  if (!(await fileTrust.isWritableOnlyByOwner(stat, path, 0o022))) {
    deny('A resource parent is group/world writable.', { path, mode: Number(stat.mode) & 0o777 });
  }
}

async function assertSandboxIdentity(
  root: string,
  expected: PathIdentity,
  fileTrust: FileTrustPolicy,
  pin: InodePin,
): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (stat === null || !sameIdentity(stat, expected) || !await pin.holds(stat)) {
    deny('The configured resource sandbox identity changed.', { root });
  }
  await assertSafeDirectory(root, stat, fileTrust);
}

async function assertNotTracked(
  path: string,
  repositoryRoots: readonly string[],
  git: GitTrackingInspector,
): Promise<void> {
  for (const repositoryRoot of repositoryRoots) {
    if (!contains(repositoryRoot, path)) continue;
    const repositoryRelativePath = relative(repositoryRoot, path);
    if (repositoryRelativePath.length === 0) continue;
    if (await git.isTracked(repositoryRoot, repositoryRelativePath)) {
      throw new ResourcePathGuardError(
        'RESOURCE_TRACKED_FILE_PROTECTED',
        'Git-tracked paths are protected from resource mutations.',
        { path, repositoryRoot, repositoryRelativePath },
      );
    }
  }
}

function contains(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !nested.startsWith(sep));
}

function containsStrict(root: string, candidate: string): boolean {
  return candidate !== root && contains(root, candidate);
}

function identity(stat: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'uid'>): PathIdentity {
  return { dev: Number(stat.dev), ino: Number(stat.ino), uid: Number(stat.uid) };
}

function sameIdentity(
  stat: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'uid'>,
  expected: PathIdentity,
): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.uid === expected.uid;
}

function deny(message: string, context: Record<string, unknown>): never {
  throw new ResourcePathGuardError('RESOURCE_PATH_DENIED', message, context);
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
