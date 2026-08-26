import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listGitWorktrees,
  readGitRemoteOrigin,
  readGitRepositoryIdentity,
} from '../git/git-runner';
import type { GitWorktreeRecord } from '../git/worktree-parser';

const defaultExcludedDirectories = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.m2',
  '.next',
  '.turbo',
  '.venv',
  '.worktrees',
  '.wtm',
  'Library',
  'Caches',
  'build',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

const markerNames: ReadonlyMap<string, TaskMarkerKind> = new Map([
  ['Makefile', 'make'],
  ['makefile', 'make'],
  ['GNUmakefile', 'make'],
  ['Justfile', 'just'],
  ['justfile', 'just'],
  ['Taskfile.yml', 'task'],
  ['Taskfile.yaml', 'task'],
  ['package.json', 'javascript'],
  ['pyproject.toml', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
]);

export interface DiscoveryOptions {
  maxDepth: number;
  excludedDirectories?: readonly string[];
}

export type TaskMarkerKind = 'make' | 'just' | 'task' | 'javascript' | 'python' | 'rust' | 'go';

export interface TaskMarker {
  kind: TaskMarkerKind;
  path: string;
  directory: string;
  workspaceLevel: boolean;
}

export interface DiscoveredRepository {
  commonGitDir: string;
  mainRoot: string;
  remoteIdentity: string | null;
  discoveredAt: string[];
  worktrees: GitWorktreeRecord[];
}

export interface DiscoveryReport {
  root: string;
  maxDepth: number;
  repositories: DiscoveredRepository[];
  taskMarkers: TaskMarker[];
}

interface GitIdentity {
  commonGitDir: string;
  detectedRoot: string;
}

export async function discoverWorkspace(root: string, options: DiscoveryOptions): Promise<DiscoveryReport> {
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
    throw new RangeError('Discovery maxDepth must be a non-negative integer');
  }

  const canonicalRoot = await realpath(root);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory()) throw new TypeError(`Workspace root is not a directory: ${canonicalRoot}`);

  const exclusions = new Set([...defaultExcludedDirectories, ...(options.excludedDirectories ?? [])]);
  const candidates: string[] = [];
  const taskMarkers: TaskMarker[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: canonicalRoot, depth: 0 }];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const entries = await readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const kind = markerNames.get(entry.name);
      if (kind !== undefined && entry.isFile()) {
        taskMarkers.push({
          kind,
          path: join(current.path, entry.name),
          directory: current.path,
          workspaceLevel: current.path === canonicalRoot,
        });
      }
    }

    const gitMarker = entries.find((entry) => entry.name === '.git');
    if (gitMarker !== undefined && (gitMarker.isDirectory() || gitMarker.isFile())) {
      candidates.push(current.path);
    }

    if (current.depth >= options.maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || exclusions.has(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  const identities = await Promise.all(candidates.map(readGitIdentity));
  const repositoriesByCommonDir = new Map<string, GitIdentity & { discoveredAt: Set<string> }>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const identity = identities[index];
    if (candidate === undefined || identity === undefined) continue;
    const existing = repositoriesByCommonDir.get(identity.commonGitDir);
    if (existing === undefined) {
      repositoriesByCommonDir.set(identity.commonGitDir, { ...identity, discoveredAt: new Set([candidate]) });
    } else {
      existing.discoveredAt.add(candidate);
    }
  }

  const repositories = await Promise.all([...repositoriesByCommonDir.values()].map(async (identity) => {
    const worktrees = await listGitWorktrees(identity.detectedRoot);
    const mainRoot = worktrees.find((worktree) => !worktree.bare)?.path ?? identity.detectedRoot;
    return {
      commonGitDir: identity.commonGitDir,
      mainRoot,
      remoteIdentity: await readRemoteIdentity(mainRoot),
      discoveredAt: orderMainFirst(mainRoot, [...identity.discoveredAt]),
      worktrees,
    };
  }));
  repositories.sort((left, right) => left.mainRoot.localeCompare(right.mainRoot));
  taskMarkers.sort((left, right) => left.path.localeCompare(right.path));

  return {
    root: canonicalRoot,
    maxDepth: options.maxDepth,
    repositories,
    taskMarkers,
  };
}

async function readGitIdentity(candidate: string): Promise<GitIdentity> {
  const identity = await readGitRepositoryIdentity(candidate);
  const commonGitDir = await realpath(identity.commonGitDir);
  const detectedRoot = await realpath(identity.topLevel);
  return { commonGitDir, detectedRoot };
}

async function readRemoteIdentity(repoPath: string): Promise<string | null> {
  return readGitRemoteOrigin(repoPath);
}

function orderMainFirst(mainRoot: string, paths: string[]): string[] {
  return paths.sort((left, right) => {
    if (left === mainRoot) return right === mainRoot ? 0 : -1;
    if (right === mainRoot) return 1;
    return left.localeCompare(right);
  });
}

export const discoveryExcludedDirectories = Object.freeze([...defaultExcludedDirectories].sort());
