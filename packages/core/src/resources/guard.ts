import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  currentUid?: number;
  git?: GitTrackingInspector;
}

interface PathIdentity {
  dev: number;
  ino: number;
  uid: number;
}

export interface ResourcePathAuthorization {
  readonly path: string;
  readonly intent: ResourceGuardIntent;
  readonly sandbox: PathIdentity;
  readonly parentPath: string;
  readonly parent: PathIdentity;
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
  const currentUid = options.currentUid ?? process.getuid?.();
  if (currentUid === undefined) deny('The current user identity is unavailable.', { sandboxRoot });
  if (
    sandboxRoot === resolve('/')
    || sandboxRoot === homeDirectory
    || sandboxRoot === workspaceRoot
    || repositoryRoots.includes(sandboxRoot)
  ) {
    deny('The configured resource sandbox is too broad.', { sandboxRoot });
  }
  const sandboxStat = await lstat(sandboxRoot);
  assertSafeDirectory(sandboxRoot, sandboxStat, currentUid);
  const sandboxIdentity = identity(sandboxStat);

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
    await assertSandboxIdentity(sandboxRoot, sandboxIdentity, currentUid);

    const leaf = await inspectExistingComponents(sandboxRoot, path, currentUid);
    if (!parentOnly && leaf !== undefined && !leaf.isFile() && !leaf.isDirectory()) {
      deny('Special files are not valid resource mutation leaves.', { path });
    }
    if (!parentOnly && leaf !== undefined && intent !== 'read-source' && leaf.isFile() && leaf.nlink > 1) {
      deny('A hardlinked resource leaf is not safe to mutate.', { path, links: leaf.nlink });
    }
    await assertNotTracked(path, repositoryRoots, git);
    const parent = await nearestExistingDirectory(path, sandboxRoot, currentUid);
    return {
      path,
      intent,
      sandbox: sandboxIdentity,
      parentPath: parent.path,
      parent: identity(parent.stat),
      ...(leaf === undefined ? {} : { leaf: identity(leaf) }),
    };
  };

  const revalidateParent = async (token: ResourcePathAuthorization): Promise<void> => {
    if (token.sandbox.dev !== sandboxIdentity.dev || token.sandbox.ino !== sandboxIdentity.ino) {
      deny('The sandbox capability does not belong to this guard.', { path: token.path });
    }
    await assertSandboxIdentity(sandboxRoot, sandboxIdentity, currentUid);
    const parent = await lstat(token.parentPath).catch(() => null);
    if (parent === null || !parent.isDirectory() || !sameIdentity(parent, token.parent)) {
      deny('A resource parent changed after authorization.', { path: token.path, parent: token.parentPath });
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
  currentUid: number,
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
    if (index < parts.length - 1) assertSafeDirectory(current, stat, currentUid);
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

async function nearestExistingDirectory(path: string, sandboxRoot: string, currentUid: number) {
  let candidate = resolve(path, '..');
  while (contains(sandboxRoot, candidate)) {
    try {
      const stat = await lstat(candidate);
      assertSafeDirectory(candidate, stat, currentUid);
      return { path: candidate, stat };
    } catch (error) {
      if (!isFileError(error, 'ENOENT')) throw error;
    }
    if (candidate === sandboxRoot) break;
    candidate = resolve(candidate, '..');
  }
  deny('No safe existing resource parent was found.', { path });
}

function assertSafeDirectory(path: string, stat: Awaited<ReturnType<typeof lstat>>, currentUid: number): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) deny('A resource parent is not a real directory.', { path });
  if (stat.uid !== currentUid) deny('A resource parent is not owned by the current user.', { path, uid: stat.uid });
  const mode = Number(stat.mode);
  if ((mode & 0o022) !== 0) deny('A resource parent is group/world writable.', { path, mode: mode & 0o777 });
}

async function assertSandboxIdentity(root: string, expected: PathIdentity, currentUid: number): Promise<void> {
  const stat = await lstat(root).catch(() => null);
  if (stat === null || !sameIdentity(stat, expected)) deny('The configured resource sandbox identity changed.', { root });
  assertSafeDirectory(root, stat, currentUid);
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
