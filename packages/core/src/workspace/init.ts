import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { parseWtmConfig, WtmConfigError, type WtmConfig } from '../config/schema';
import { stripByteOrderMark } from '../config/toml-text';
import { renderConfigDraft, type OutOfRangePort } from '../detect/config-draft';
import { detectWorkspaceServices, type WorkspaceDetection } from '../detect/service-detection';
import type { ReconcileResult, RepositoryRecord, StateStore, WorkspaceRecord } from '../state/store';
import { discoverWorkspace, type DiscoveryReport } from './discover';

export interface InitInput {
  root: string;
  maxDepth?: number;
  globalOnly?: boolean;
  userDataDir: string;
  stateStore: StateStore;
  workspaceName?: string;
  /**
   * Whether to read the repositories for the ports, allowlists, and cross-service addresses
   * they already declare, and write what is found into the configuration. On by default;
   * turning it off leaves `wtm.toml` with nothing but its name and version.
   */
  detect?: boolean;
  /**
   * A starting `wtm.toml` seed for a brand-new configuration — the caller (the CLI's `--preset`
   * option) has already validated `name` against a fixed known list and read `toml` from
   * `examples/<name>/wtm.toml`, verbatim, so it and the seeded output can never drift. It only
   * ever takes effect where there is nothing else to write: the configuration does not exist yet,
   * and detection (unless turned off) found nothing it would write into it — the same tables
   * `configBlocks`/`pendingConfig` already report. When detection did find something to declare
   * and a preset was asked for anyway, initialization refuses rather than silently discarding one
   * or the other — see `InitResult.preset` and the thrown error's
   * `context.conflict === 'preset-detection-conflict'`.
   */
  preset?: { name: string; toml: string };
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
  /** What the repositories were read to be, or `null` when detection was turned off. */
  detection: WorkspaceDetection | null;
  /**
   * Every table detection would write, and whether the configuration already has it. The
   * tables themselves are in the file, or in `pendingConfig`, rather than repeated here.
   */
  configBlocks: Array<{ path: string; present: boolean }>;
  /**
   * The tables an existing configuration does not have yet. `wtm init` never edits a file it
   * did not write, so this is what `wtm detect --write` would append.
   */
  pendingConfig: string;
  /** Ports a repository asked for that the configuration's own range would never offer. */
  outOfRangePorts: OutOfRangePort[];
  /**
   * What became of an explicit `--preset`; `null` when none was given. `applied` is true only
   * when the preset text actually became the new file's seed. It is false when a `wtm.toml`
   * already existed — `wtm init` never edits a file it did not write, the same rule detection
   * follows.
   */
  preset: { name: string; applied: boolean } | null;
}

export async function initializeWorkspace(input: InitInput): Promise<InitResult> {
  const discovery = await discoverWorkspace(input.root, { maxDepth: input.maxDepth ?? 5 });
  const configPath = input.globalOnly === true
    ? await globalOnlyConfigPath(input.userDataDir, discovery.root)
    : join(discovery.root, 'wtm.toml');
  const defaultName = basename(discovery.root);
  const selectedName = input.workspaceName ?? defaultName;
  const detection = input.detect === false ? null : await detectWorkspaceServices({
    root: discovery.root,
    repositories: discovery.repositories.map(({ mainRoot }) => ({ root: mainRoot })),
  });
  const config = await ensureMinimalConfig({
    path: configPath,
    selectedName,
    defaultName,
    detection,
    ...(input.preset === undefined ? {} : { preset: input.preset }),
    ...(input.beforeConfigCommit === undefined ? {} : { beforeConfigCommit: input.beforeConfigCommit }),
  });

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
    detection,
    configBlocks: config.blocks,
    pendingConfig: config.pending,
    outOfRangePorts: config.outOfRange,
    preset: config.preset,
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

interface MinimalConfigInput {
  path: string;
  selectedName: string;
  defaultName: string;
  detection: WorkspaceDetection | null;
  preset?: { name: string; toml: string };
  beforeConfigCommit?: InitInput['beforeConfigCommit'];
}

async function ensureMinimalConfig(input: MinimalConfigInput): Promise<{
  workspaceName: string;
  changed: boolean;
  blocks: Array<{ path: string; present: boolean }>;
  pending: string;
  outOfRange: OutOfRangePort[];
  preset: { name: string; applied: boolean } | null;
}> {
  const { path } = input;
  const snapshot = await readConfigSnapshot(path);
  // Stripped here rather than left for `parseConfigToml`: `original` is also the text the rewrite
  // below is built from, and a leading marker has to be out of the way of both. It only reaches
  // the write path when the file was absent — a present file is either already conformant or
  // reported as needing a change — so no existing file loses its marker to this.
  const original = snapshot.state === 'present' ? stripByteOrderMark(snapshot.content) : '';

  if (snapshot.state === 'present') {
    const existing = original.length === 0 ? parseWtmConfig({}, path) : parseConfigToml(original, path);
    const workspaceName = existing.workspace?.name ?? input.selectedName;
    const draft = configDraft(input.detection, existing);
    const requiredChanges = requiredConfigChanges(existing, input.defaultName);
    // The file is the workspace's, not WTM's: what detection (or a preset) found is reported,
    // never applied — the same rule for both.
    const presetOutcome: { name: string; applied: boolean } | null = input.preset === undefined
      ? null
      : { name: input.preset.name, applied: false };
    if (requiredChanges.length === 0) {
      return {
        workspaceName,
        changed: false,
        blocks: blockIndex(draft.blocks),
        pending: draft.additions,
        outOfRange: draft.outOfRange,
        preset: presetOutcome,
      };
    }
    throw configUpdateRequired(path, requiredChanges);
  }

  // Nothing exists yet: a preset may seed the whole document, but only where there is nothing
  // else to write — a real detection result always wins over an example, never the other way.
  // `detection.services` has one entry per repository whether or not anything about it was
  // actually detected, so eligibility is decided from what detection would *write* (`draft`),
  // the same thing `configBlocks`/`pendingConfig` already report to every other caller.
  const draft = configDraft(input.detection, undefined);
  const preset = input.preset;
  if (preset !== undefined && draft.blocks.length > 0) throw presetDetectionConflict(path, preset.name);
  let updated = preset === undefined ? original : seedFromPreset(preset.toml, input.selectedName, path);

  const existing = updated.length === 0 ? parseWtmConfig({}, path) : parseConfigToml(updated, path);
  const workspaceName = existing.workspace?.name ?? input.selectedName;

  if (existing.version === undefined) updated = `version = 1\n${updated}`;
  if (existing.workspace?.name === undefined) updated = addWorkspaceName(updated, workspaceName);
  if (draft.document.length > 0) updated = `${updated}\n${draft.document}`;

  parseConfigToml(updated, path);
  await atomicCreateFile(path, updated, input.beforeConfigCommit);
  return {
    workspaceName,
    changed: true,
    blocks: blockIndex(draft.blocks),
    pending: '',
    outOfRange: draft.outOfRange,
    preset: preset === undefined ? null : { name: preset.name, applied: true },
  };
}

/**
 * Substitutes the selected workspace's real name for the preset's own placeholder, so an
 * `examples/<name>/wtm.toml` copy that declares `name = "nextjs"` seeds a workspace named after
 * the actual directory instead — matching every other `wtm init` naming path. Every preset file
 * this repository ships is written to this exact shape (`[workspace]` immediately followed by one
 * `name = "..."` line), so a mismatch here means the shipped example itself is malformed.
 */
function seedFromPreset(toml: string, selectedName: string, path: string): string {
  const normalized = toml.endsWith('\n') ? toml : `${toml}\n`;
  const workspaceNameLine = /^\[workspace\]\nname = "[^"]*"\n/m;
  if (!workspaceNameLine.test(normalized)) {
    throw new WtmConfigError('WTM preset configuration is malformed: expected [workspace] followed by a name line.', {
      source: path,
      category: 'preset-malformed',
    });
  }
  return normalized.replace(workspaceNameLine, `[workspace]\nname = ${JSON.stringify(selectedName)}\n`);
}

function presetDetectionConflict(path: string, name: string): WtmConfigError {
  return new WtmConfigError(
    `Detection found services this repository declares; --preset "${name}" would silently discard them. `
    + `Rerun with --no-detect --preset ${name} to use the preset instead, or drop --preset to keep what detection found.`,
    {
      source: path,
      conflict: 'preset-detection-conflict',
      preset: name,
      action: `Rerun with --no-detect --preset ${name}, or drop --preset to keep what detection found.`,
    },
  );
}

function blockIndex(blocks: ReadonlyArray<{ path: string; present: boolean }>): Array<{ path: string; present: boolean }> {
  return blocks.map(({ path, present }) => ({ path, present }));
}

function configDraft(detection: WorkspaceDetection | null, existing: WtmConfig | undefined) {
  if (detection === null) return { blocks: [], outOfRange: [], additions: '', document: '' };
  return renderConfigDraft({ detection, ...(existing === undefined ? {} : { existing }) });
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
