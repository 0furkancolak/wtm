import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { parseWtmConfig, WtmConfigError } from '../config/schema';
import type { ReconcileResult, RepositoryRecord, StateStore, WorkspaceRecord } from '../state/store';
import { discoverWorkspace, type DiscoveryReport } from './discover';

export interface InitInput {
  root: string;
  maxDepth?: number;
  globalOnly?: boolean;
  userDataDir: string;
  stateStore: StateStore;
  workspaceName?: string;
  beforeConfigCommit?: (context: { path: string }) => Promise<void> | void;
}

export interface InitializedRepository {
  repository: RepositoryRecord;
  reconciliation: ReconcileResult;
}

export interface InitResult {
  workspace: WorkspaceRecord;
  configPath: string;
  configChanged: boolean;
  discovery: DiscoveryReport;
  repositories: InitializedRepository[];
}

export async function initializeWorkspace(input: InitInput): Promise<InitResult> {
  const discovery = await discoverWorkspace(input.root, { maxDepth: input.maxDepth ?? 5 });
  const configPath = input.globalOnly === true
    ? await globalOnlyConfigPath(input.userDataDir, discovery.root)
    : join(discovery.root, 'wtm.toml');
  const defaultName = basename(discovery.root);
  const selectedName = input.workspaceName ?? defaultName;
  const config = await ensureMinimalConfig(
    configPath,
    selectedName,
    defaultName,
    input.beforeConfigCommit,
  );

  const registered = input.stateStore.transaction(() => {
    const workspace = input.stateStore.upsertWorkspace({
      name: config.workspaceName,
      root: discovery.root,
      scope: input.globalOnly === true ? 'global-only' : 'local',
      configPath,
    });
    const repositories = discovery.repositories.map((discovered) => {
      const repository = input.stateStore.upsertRepository({
        workspaceId: workspace.id,
        commonGitDir: discovered.commonGitDir,
        mainRoot: discovered.mainRoot,
        remoteIdentity: discovered.remoteIdentity,
      });
      return {
        repository,
        reconciliation: input.stateStore.reconcileWorktrees(repository.id, discovered.worktrees),
      };
    });
    return { workspace, repositories };
  });

  return {
    workspace: registered.workspace,
    configPath,
    configChanged: config.changed,
    discovery,
    repositories: registered.repositories,
  };
}

async function globalOnlyConfigPath(userDataDir: string, workspaceRoot: string): Promise<string> {
  const requestedDataDir = resolve(userDataDir);
  await mkdir(requestedDataDir, { recursive: true });
  const canonicalDataDir = await realpath(requestedDataDir);
  const requestedWorkspaceDirectory = join(canonicalDataDir, 'workspaces');
  await mkdir(requestedWorkspaceDirectory, { recursive: true });
  const workspaceDirectory = await realpath(requestedWorkspaceDirectory);
  assertPathWithin(canonicalDataDir, workspaceDirectory);
  const slug = basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const digest = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  const path = join(workspaceDirectory, `${slug}-${digest}.toml`);
  assertPathWithin(canonicalDataDir, path);
  return path;
}

async function ensureMinimalConfig(
  path: string,
  selectedName: string,
  defaultName: string,
  beforeConfigCommit?: InitInput['beforeConfigCommit'],
): Promise<{
  workspaceName: string;
  changed: boolean;
}> {
  const snapshot = await readConfigSnapshot(path);
  const original = snapshot.state === 'present' ? snapshot.content : '';

  const existing = original.length === 0
    ? parseWtmConfig({}, path)
    : parseConfigToml(original, path);
  const workspaceName = existing.workspace?.name ?? selectedName;
  const requiredChanges = requiredConfigChanges(existing, defaultName);
  if (snapshot.state === 'present') {
    if (requiredChanges.length === 0) return { workspaceName, changed: false };
    throw configUpdateRequired(path, requiredChanges);
  }

  let updated = original;

  if (existing.version === undefined) updated = `version = 1\n${updated}`;
  if (existing.workspace?.name === undefined) updated = addWorkspaceName(updated, workspaceName);

  parseConfigToml(updated, path);
  await atomicCreateFile(path, updated, beforeConfigCommit);
  return { workspaceName, changed: true };
}

function parseConfigToml(content: string, source: string): ReturnType<typeof parseWtmConfig> {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    throw new WtmConfigError('WTM configuration contains invalid TOML syntax.', {
      source,
      category: 'toml-syntax',
      action: 'Correct the TOML syntax in the source file, then rerun wtm init.',
    });
  }
  return parseWtmConfig(parsed, source);
}

function addWorkspaceName(content: string, workspaceName: string): string {
  const encodedName = JSON.stringify(workspaceName);
  const workspaceHeader = /^\[workspace\][\t ]*(?:#.*)?$/m;
  const match = workspaceHeader.exec(content);
  if (match !== null) {
    const insertion = match.index + match[0].length;
    return `${content.slice(0, insertion)}\nname = ${encodedName}${content.slice(insertion)}`;
  }

  const separator = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}[workspace]\nname = ${encodedName}\n`;
}

type ConfigSnapshot =
  | { state: 'absent' }
  | { state: 'present'; content: string };

async function readConfigSnapshot(path: string): Promise<ConfigSnapshot> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return { state: 'absent' };
    if (isSymbolicLinkError(error)) {
      throw new WtmConfigError('WTM configuration must not be a symbolic link.', { source: path });
    }
    throw error;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new WtmConfigError('WTM configuration path is not a regular file.', { source: path });
    }
    return {
      state: 'present',
      content: await handle.readFile({ encoding: 'utf8' }),
    };
  } finally {
    await handle.close();
  }
}

async function atomicCreateFile(
  path: string,
  content: string,
  beforeConfigCommit?: InitInput['beforeConfigCommit'],
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  assertPathWithin(parent, path);
  const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    await beforeConfigCommit?.({ path });
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isAlreadyExists(error)) throw concurrentCreationConflict(path);
      throw error;
    }
    await rm(temporaryPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function concurrentCreationConflict(path: string): WtmConfigError {
  return new WtmConfigError('WTM configuration changed during initialization; no changes were written.', {
    source: path,
    conflict: 'concurrent-creation',
    action: 'Review the current configuration and rerun wtm init.',
  });
}

type RequiredConfigChange =
  | { path: 'version'; value: 1 }
  | { path: 'workspace.name'; value: string };

function requiredConfigChanges(
  existing: ReturnType<typeof parseWtmConfig>,
  defaultName: string,
): RequiredConfigChange[] {
  const changes: RequiredConfigChange[] = [];
  if (existing.version === undefined) changes.push({ path: 'version', value: 1 });
  if (existing.workspace?.name === undefined) {
    changes.push({ path: 'workspace.name', value: defaultName });
  }
  return changes;
}

function configUpdateRequired(path: string, requiredChanges: RequiredConfigChange[]): WtmConfigError {
  return new WtmConfigError('Existing WTM configuration requires an update; no changes were written.', {
    source: path,
    conflict: 'update-required',
    requiredChanges,
    action: 'Apply the listed requiredChanges to the existing file, then rerun wtm init.',
  });
}

function assertPathWithin(parent: string, child: string): void {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (pathFromParent === '' || pathFromParent === '..' || pathFromParent.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes its allowed directory: ${child}`);
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isSymbolicLinkError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP';
}
