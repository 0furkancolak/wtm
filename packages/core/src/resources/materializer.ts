import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResourceGuard, ResourcePathAuthorization } from './guard';

export type MaterializationRequest =
  | { policy: 'isolated'; targetPath: string }
  | { policy: 'ephemeral'; targetPath: string }
  | { policy: 'shared' | 'native-cache' | 'external' | 'ignore'; targetPath: string }
  | { policy: 'generated'; targetPath: string; contents: string | Uint8Array; mode?: number }
  | { policy: 'copy' | 'clone'; targetPath: string; sourcePath: string; mutable?: boolean }
  | {
    policy: 'symlink'; targetPath: string; sourcePath: string; immutable: boolean;
    allowedSourceRoots: readonly string[];
  };

interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface SourceManifestEntry {
  path: string;
  kind: 'file' | 'directory';
  dev: string;
  ino: string;
  uid: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
  hash?: string;
}

interface OpenSourceSnapshotEntry {
  path: string;
  absolutePath: string;
  kind: 'file' | 'directory';
  identity: StableFileIdentity;
  hash?: string;
  children?: readonly string[];
  handle: FileHandle;
}

interface OpenSourceSnapshot {
  entries: readonly OpenSourceSnapshotEntry[];
  manifest: readonly SourceManifestEntry[];
}

interface StableFileIdentity {
  dev: string;
  ino: string;
  uid: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
}

const MAX_RETAINED_SOURCE_ENTRIES = 256;

export interface MaterializationPlan {
  readonly version: 1;
  readonly policy: MaterializationRequest['policy'];
  readonly targetPath: string;
  readonly sourcePath?: string;
  readonly contents?: string | Uint8Array;
  readonly mode?: number;
  readonly immutable: boolean;
  readonly ownership: 'wtm' | 'external';
  readonly allowedSourceRoots: readonly string[];
  readonly authorization?: ResourcePathAuthorization;
  readonly sourceIdentity?: FileIdentity;
  readonly sourceManifest?: readonly SourceManifestEntry[];
  readonly recoveryKey: string;
}

export interface CloneFileCapability {
  cloneFile(sourcePath: string, targetPath: string): Promise<void>;
}

export interface MaterializationHooks {
  beforePublish?(plan: MaterializationPlan): Promise<void> | void;
  duringCopy?(sourcePath: string): Promise<void> | void;
  afterPublish?(plan: MaterializationPlan): Promise<void> | void;
  afterPublishBeforeEvidence?(plan: MaterializationPlan): Promise<void> | void;
  afterRecoveryEvidence?(plan: MaterializationPlan): Promise<void> | void;
  duringStageCleanup?(stagePath: string, relativePath: string): Promise<void> | void;
  beforeStageCleanupRmdir?(stagePath: string): Promise<void> | void;
  afterStageRemovedBeforeCleanupEvidence?(stagePath: string): Promise<void> | void;
}

export interface ApplyMaterializationOptions {
  guard: ResourceGuard;
  clone?: CloneFileCapability;
  hooks?: MaterializationHooks;
  maxEntries?: number;
  maxDepth?: number;
}

export interface MaterializationResult {
  targetPath: string;
  policy: MaterializationPlan['policy'];
  method: 'directory' | 'generated' | 'copy' | 'clone' | 'copy-fallback' | 'symlink' | 'not-owned';
}

export class ResourceMaterializationError extends Error {
  readonly severity = 'error' as const;

  constructor(
    readonly code: 'RESOURCE_PATH_DENIED' | 'RESOURCE_CLONE_UNAVAILABLE' | 'RESOURCE_CLEANUP_FAILED',
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ResourceMaterializationError';
  }
}

export function buildMaterializationPlan(request: MaterializationRequest): MaterializationPlan {
  assertAbsoluteResolved(request.targetPath, 'targetPath');
  if ('sourcePath' in request) assertAbsoluteResolved(request.sourcePath, 'sourcePath');
  if (request.policy === 'symlink' && request.immutable !== true) {
    throw materializationDenied('Mutable resources may not be symlinked.', { targetPath: request.targetPath });
  }
  if (request.policy === 'symlink' && request.allowedSourceRoots.length === 0) {
    throw materializationDenied('Immutable symlink sources require an explicit allowlist.', { sourcePath: request.sourcePath });
  }
  const mode = request.policy === 'generated' ? conservativeMode(request.mode ?? 0o600, false) : undefined;
  const plan: Omit<MaterializationPlan, 'recoveryKey'> = {
    version: 1,
    policy: request.policy,
    targetPath: resolve(request.targetPath),
    ...('sourcePath' in request ? { sourcePath: resolve(request.sourcePath) } : {}),
    ...(request.policy === 'generated' ? { contents: request.contents, mode: mode as number } : {}),
    immutable: request.policy === 'symlink',
    ownership: isExternallyOwnedPolicy(request.policy) ? 'external' : 'wtm',
    allowedSourceRoots: request.policy === 'symlink'
      ? request.allowedSourceRoots.map((root) => resolve(root)).sort(codeUnitCompare)
      : [],
  };
  return { ...plan, recoveryKey: materializationRecoveryKey(plan) };
}

export async function planResourceMaterialization(
  request: MaterializationRequest,
  guard: ResourceGuard,
): Promise<MaterializationPlan> {
  const pure = buildMaterializationPlan(request);
  if (pure.ownership === 'external') return pure;
  const authorization = await guard.authorize(pure.targetPath, pure.policy === 'symlink' ? 'symlink-target' : 'publish');
  if (await lstatIfExists(authorization.path) !== null) {
    throw materializationDenied('WTM never adopts or overwrites an existing materialization target.', {
      targetPath: authorization.path,
    });
  }
  if (pure.sourcePath === undefined) return { ...pure, targetPath: authorization.path, authorization };

  const sourcePath = await realpath(pure.sourcePath).catch(() => {
    throw materializationDenied('The materialization source does not exist.', { sourcePath: pure.sourcePath });
  });
  const sourceStat = await lstat(sourcePath);
  assertCopyableSource(sourcePath, sourceStat);
  if (pure.policy === 'symlink') {
    const allowedRoots = await Promise.all(pure.allowedSourceRoots.map(async (root) =>
      realpath(root).catch(() => {
        throw materializationDenied('An allowed symlink source root does not exist.', { root });
      })));
    if (!allowedRoots.some((root) => contains(root, sourcePath))) {
      throw materializationDenied('The immutable symlink source is outside its explicit allowlist.', {
        sourcePath,
        allowedRoots,
      });
    }
    return {
      ...pure,
      targetPath: authorization.path,
      sourcePath,
      allowedSourceRoots: allowedRoots.sort(codeUnitCompare),
      authorization,
      sourceIdentity: fileIdentity(sourceStat),
    };
  }
  return {
    ...pure,
    targetPath: authorization.path,
    sourcePath,
    authorization,
    sourceIdentity: fileIdentity(sourceStat),
    ...((pure.policy === 'copy' || pure.policy === 'clone')
      ? { sourceManifest: await buildSourceManifest(sourcePath, { maxEntries: 10_000, maxDepth: 64 }) }
      : {}),
  };
}

export async function applyMaterializationPlan(
  plan: MaterializationPlan,
  options: ApplyMaterializationOptions,
): Promise<MaterializationResult> {
  if (plan.ownership === 'external') {
    return { targetPath: plan.targetPath, policy: plan.policy, method: 'not-owned' };
  }
  const maxEntries = options.maxEntries ?? 10_000;
  const maxDepth = options.maxDepth ?? 64;
  const originalAuthorization = plan.authorization ?? await options.guard.authorize(plan.targetPath, 'publish');
  await options.guard.revalidateParent(originalAuthorization);
  const recoveredMethod = await reconcileOwnedStages(
    plan, originalAuthorization, options.guard, maxEntries, maxDepth, options.hooks,
  );
  if (recoveredMethod !== null) {
    return { targetPath: plan.targetPath, policy: plan.policy, method: recoveredMethod };
  }
  await options.guard.revalidate(originalAuthorization);
  if (await lstatIfExists(plan.targetPath) !== null) {
    throw materializationDenied('The materialization target already exists.', { targetPath: plan.targetPath });
  }

  const stageId = randomUUID().replaceAll('-', '');
  const stagePath = join(originalAuthorization.parentPath, `.wtm-stage-${plan.recoveryKey}-${stageId}`);
  const sourceSnapshot = plan.sourceManifest === undefined
    ? null
    : await openSourceSnapshot(plan.sourcePath as string, {
      maxEntries: Math.min(maxEntries, MAX_RETAINED_SOURCE_ENTRIES), maxDepth,
    });
  const payloadPath = join(stagePath, 'payload');
  let method: MaterializationResult['method'];
  try {
    if (sourceSnapshot !== null && !sameSourceManifest(sourceSnapshot.manifest, plan.sourceManifest as readonly SourceManifestEntry[])) {
      throw materializationDenied('The materialization source tree changed after planning.', { sourcePath: plan.sourcePath });
    }
    const stageAuthorization = await options.guard.authorize(stagePath, 'write');
    await options.guard.revalidate(stageAuthorization);
    await mkdir(stagePath, { mode: 0o700 });
    const intentPath = join(stagePath, 'intent.json');
    await writeExclusiveFile(intentPath, JSON.stringify({
      version: 2,
      stageId,
      recoveryKey: plan.recoveryKey,
      policy: plan.policy,
      target: plan.targetPath,
      parent: originalAuthorization.parent,
      state: 'prepared',
    }), 0o600);
    await syncDirectory(stagePath);

    switch (plan.policy) {
      case 'isolated':
      case 'ephemeral':
        await mkdir(payloadPath, { mode: 0o700 });
        method = 'directory';
        break;
      case 'generated':
        await writeExclusiveFile(payloadPath, plan.contents ?? '', plan.mode ?? 0o600);
        method = 'generated';
        break;
      case 'copy':
        await copySourceTree(plan, payloadPath, { maxEntries, maxDepth }, options.hooks);
        method = 'copy';
        break;
      case 'clone':
        method = await cloneOrCopy(
          plan, payloadPath, options.clone ?? nodeCloneCapability, { maxEntries, maxDepth }, options.hooks,
        );
        break;
      case 'symlink':
        await assertSourceIdentity(plan);
        await symlink(plan.sourcePath as string, payloadPath);
        method = 'symlink';
        break;
      case 'shared':
      case 'native-cache':
      case 'external':
      case 'ignore':
        throw materializationDenied('Externally owned policies cannot enter WTM staging.', { policy: plan.policy });
    }

    if (plan.sourceManifest !== undefined) {
      await assertCopiedStageManifest(plan, payloadPath, { maxEntries, maxDepth });
    }
    await options.hooks?.beforePublish?.(plan);
    const symlinkSource = plan.policy === 'symlink'
      ? await resolveAllowedSymlinkSource(plan)
      : undefined;
    await assertSourceIdentity(plan);
    if (plan.sourceManifest !== undefined) {
      await assertCopiedStageManifest(plan, payloadPath, { maxEntries, maxDepth });
    }
    await options.guard.revalidate(originalAuthorization);
    if (await lstatIfExists(plan.targetPath) !== null) {
      throw materializationDenied('A concurrent materialization winner already exists.', { targetPath: plan.targetPath });
    }
    const payload = await lstat(payloadPath);
    const payloadDigest = await digestMaterializedPath(payloadPath, { maxEntries, maxDepth });
    const publishingPath = join(stagePath, 'publishing.json');
    await writeExclusiveFile(publishingPath, JSON.stringify({
      version: 1,
      stageId,
      method,
      target: plan.targetPath,
      payload: fileIdentity(payload),
      digest: payloadDigest,
      kind: payload.isDirectory() ? 'directory' : payload.isFile() ? 'file' : 'symlink',
      ...(payload.isSymbolicLink() ? { linkTarget: await readlink(payloadPath) } : {}),
    }), 0o600);
    await syncDirectory(stagePath);
    await options.guard.revalidate(originalAuthorization);
    if (await lstatIfExists(plan.targetPath) !== null) {
      throw materializationDenied('A concurrent materialization winner already exists.', { targetPath: plan.targetPath });
    }
    if (sourceSnapshot !== null) {
      await revalidateOpenSourceSnapshot(
        sourceSnapshot, plan.sourceManifest as readonly SourceManifestEntry[], { maxEntries, maxDepth },
      );
    } else if (plan.policy === 'symlink') {
      await resolveAllowedSymlinkSource(plan);
    } else {
      await assertSourceIdentity(plan);
    }
    const publicationIdentity = await publishNoClobber(payloadPath, plan.targetPath, payload, symlinkSource);
    await options.hooks?.afterPublishBeforeEvidence?.(plan);
    const published = await lstat(plan.targetPath);
    await assertPublishedTargetMatchesPayload(
      payload, publicationIdentity, published, payloadPath, plan.targetPath, payloadDigest, symlinkSource,
      { maxEntries, maxDepth },
    );
    const publishedEvidence: PublishedEvidence = {
      version: 1,
      stageId,
      method,
      target: plan.targetPath,
      identity: fileIdentity(published),
      digest: payloadDigest,
      kind: published.isDirectory() ? 'directory' : published.isFile() ? 'file' : 'symlink',
      ...(published.isSymbolicLink() ? { linkTarget: await readlink(plan.targetPath) } : {}),
    };
    await writeExclusiveFile(join(stagePath, 'published.json'), JSON.stringify(publishedEvidence), 0o600);
    await syncDirectory(stagePath);
    await options.hooks?.afterPublish?.(plan);
    await cleanupOwnedStage(
      plan, originalAuthorization, options.guard, stagePath, { state: 'published', published: publishedEvidence },
      maxEntries, maxDepth, options.hooks,
    );
    return { targetPath: plan.targetPath, policy: plan.policy, method };
  } catch (error) {
    if (error instanceof ResourceMaterializationError) throw error;
    throw new ResourceMaterializationError('RESOURCE_CLEANUP_FAILED', 'Resource materialization failed closed.', {
      targetPath: plan.targetPath,
      stagePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (sourceSnapshot !== null) await closeOpenSourceSnapshot(sourceSnapshot);
  }
}

async function reconcileOwnedStages(
  plan: MaterializationPlan,
  authorization: ResourcePathAuthorization,
  guard: ResourceGuard,
  maxEntries: number,
  maxDepth: number,
  hooks?: MaterializationHooks,
): Promise<MaterializationResult['method'] | null> {
  let recovered: MaterializationResult['method'] | null = null;
  const prefix = `.wtm-stage-${plan.recoveryKey}-`;
  const cleanupPrefix = `.wtm-cleanup-${plan.recoveryKey}-`;
  const names: string[] = [];
  const cleanupNames: string[] = [];
  let inventoryEntries = 0;
  let stageEntries = 0;
  const directory = await opendir(authorization.parentPath);
  for await (const entry of directory) {
    if (++inventoryEntries > 10_000) {
      throw materializationDenied('Recovery stage inventory exceeded its configured work bound.', {
        parentPath: authorization.parentPath,
      });
    }
    if (!entry.name.startsWith('.wtm-stage-') && !entry.name.startsWith('.wtm-cleanup-')) continue;
    if (++stageEntries > 128) {
      throw materializationDenied('Recovery stage namespace exceeded its configured candidate bound.', {
        parentPath: authorization.parentPath,
      });
    }
    if (entry.name.startsWith(prefix)) names.push(entry.name);
    if (entry.name.startsWith(cleanupPrefix)) cleanupNames.push(entry.name);
  }
  names.sort(codeUnitCompare);
  cleanupNames.sort(codeUnitCompare);
  let candidates = 0;
  const cleanedStageIds = new Set<string>();
  for (const name of cleanupNames) {
    if (++candidates > 16) {
      throw materializationDenied('Too many exact recovery stages exist for one materialization plan.', {
        targetPath: plan.targetPath,
      });
    }
    const match = /^([0-9a-f]{32})\.json$/.exec(name.slice(cleanupPrefix.length));
    if (match === null) {
      throw materializationDenied('An exact cleanup evidence file has an invalid identifier.', {
        cleanupPath: join(authorization.parentPath, name),
      });
    }
    const stageId = match[1] as string;
    const cleanupPath = join(authorization.parentPath, name);
    const cleanup = await readExactStageJson(cleanupPath);
    if (!isMatchingCleanupEvidence(cleanup, stageId, plan, authorization)) {
      throw materializationDenied('Exact stage cleanup evidence does not match its plan capability.', { cleanupPath });
    }
    const method = await resumeOwnedStageCleanup(
      cleanup, cleanupPath, authorization, guard, maxEntries, maxDepth, hooks,
    );
    if (method !== null) recovered = method;
    cleanedStageIds.add(stageId);
  }
  for (const name of names) {
    if (++candidates > 16) {
      throw materializationDenied('Too many exact recovery stages exist for one materialization plan.', {
        targetPath: plan.targetPath,
      });
    }
    const stageId = name.slice(prefix.length);
    if (!/^[0-9a-f]{32}$/.test(stageId)) {
      throw materializationDenied('An exact recovery stage has an invalid identifier.', { stagePath: join(authorization.parentPath, name) });
    }
    if (cleanedStageIds.has(stageId)) continue;
    const stagePath = join(authorization.parentPath, name);
    const stage = await lstatIfExists(stagePath);
    if (stage === null || !stage.isDirectory() || stage.isSymbolicLink() || Number(stage.uid) !== process.getuid?.()
      || (Number(stage.mode) & 0o777) !== 0o700) {
      throw materializationDenied('An exact recovery stage is not an owner-only real directory.', { stagePath });
    }
    const intent = await readExactStageJson(join(stagePath, 'intent.json'));
    if (!isMatchingStageIntent(intent, stageId, plan, authorization)) {
      throw materializationDenied('An exact recovery stage intent does not match its plan capability.', { stagePath });
    }
    await guard.revalidateParent(authorization);
    const published = await readExactStageJson(join(stagePath, 'published.json'), false);
    const target = await lstatIfExists(plan.targetPath);
    if (target === null) {
      await cleanupOwnedStage(
        plan, authorization, guard, stagePath, { state: 'absent' }, maxEntries, maxDepth, hooks,
      );
      continue;
    }
    if (
      !isPublishedEvidence(published)
      || published.stageId !== stageId
      || !await targetMatchesPublished(target, plan.targetPath, published, { maxEntries, maxDepth })
    ) {
      const publishing = await readExactStageJson(join(stagePath, 'publishing.json'), false);
      if (!isPublishingEvidence(publishing) || publishing.stageId !== stageId) {
        throw materializationDenied('An existing target does not match its exact owned publication evidence.', {
          targetPath: plan.targetPath,
          stagePath,
        });
      }
      const completed = await completePublishingRecovery(
        plan, stagePath, target, publishing, { maxEntries, maxDepth }, hooks,
      );
      await cleanupOwnedStage(
        plan, authorization, guard, stagePath, { state: 'published', published: completed },
        maxEntries, maxDepth, hooks,
      );
      recovered = completed.method;
      continue;
    }
    await cleanupOwnedStage(
      plan, authorization, guard, stagePath, { state: 'published', published }, maxEntries, maxDepth, hooks,
    );
    recovered = published.method;
  }
  return recovered;
}

async function cleanupOwnedStage(
  plan: MaterializationPlan,
  authorization: ResourcePathAuthorization,
  guard: ResourceGuard,
  stagePath: string,
  outcome: StageCleanupEvidence['outcome'],
  maxEntries: number,
  maxDepth: number,
  hooks?: MaterializationHooks,
): Promise<void> {
  const stageId = basename(stagePath).slice(`.wtm-stage-${plan.recoveryKey}-`.length);
  if (!/^[0-9a-f]{32}$/.test(stageId)) {
    throw materializationDenied('Owned stage cleanup received an invalid stage capability.', { stagePath });
  }
  const stage = await lstat(stagePath);
  if (!stage.isDirectory() || stage.isSymbolicLink() || Number(stage.uid) !== process.getuid?.()
    || (Number(stage.mode) & 0o777) !== 0o700) {
    throw materializationDenied('Owned stage cleanup requires an owner-only real directory.', { stagePath });
  }
  const cleanupPath = join(authorization.parentPath, `.wtm-cleanup-${plan.recoveryKey}-${stageId}.json`);
  const evidence: StageCleanupEvidence = {
    version: 1,
    recoveryKey: plan.recoveryKey,
    stageId,
    target: plan.targetPath,
    parent: authorization.parent,
    stage: fileIdentity(stage),
    outcome,
  };
  await writeExclusiveFile(cleanupPath, JSON.stringify(evidence), 0o600);
  await syncDirectory(authorization.parentPath);
  await resumeOwnedStageCleanup(
    evidence, cleanupPath, authorization, guard, maxEntries, maxDepth, hooks,
  );
}

async function resumeOwnedStageCleanup(
  evidence: StageCleanupEvidence,
  cleanupPath: string,
  authorization: ResourcePathAuthorization,
  guard: ResourceGuard | undefined,
  maxEntries: number,
  maxDepth: number,
  hooks?: MaterializationHooks,
): Promise<MaterializationResult['method'] | null> {
  if (guard !== undefined) await guard.revalidateParent(authorization);
  const target = await lstatIfExists(evidence.target);
  if (evidence.outcome.state === 'absent') {
    if (target !== null) {
      throw materializationDenied('Absent-stage cleanup evidence found an existing target.', { targetPath: evidence.target });
    }
  } else if (target === null || !await targetMatchesPublished(
    target, evidence.target, evidence.outcome.published, { maxEntries, maxDepth },
  )) {
    throw materializationDenied('Published-stage cleanup evidence no longer matches its exact target.', {
      targetPath: evidence.target,
    });
  }

  const stagePath = join(authorization.parentPath, `.wtm-stage-${evidence.recoveryKey}-${evidence.stageId}`);
  const stage = await lstatIfExists(stagePath);
  if (stage !== null) {
    // Removing owned descendants necessarily changes directory size and times. The
    // cleanup capability is bound to the directory node itself, not mutable
    // directory metadata, so interrupted cleanup may safely resume only on the
    // exact recorded dev/inode/uid/mode tuple.
    if (!stage.isDirectory() || stage.isSymbolicLink() || !sameNodeIdentity(stage, evidence.stage)) {
      throw materializationDenied('The cleanup-owned stage identity changed.', { stagePath });
    }
    await removeOwnedStageTree(stagePath, evidence.stage, maxEntries, maxDepth, hooks);
  }
  await hooks?.afterStageRemovedBeforeCleanupEvidence?.(stagePath);
  await removeExactCleanupEvidence(cleanupPath);
  await syncDirectory(authorization.parentPath);
  return evidence.outcome.state === 'published' ? evidence.outcome.published.method : null;
}

async function removeExactCleanupEvidence(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || Number(before.uid) !== process.getuid?.()
    || Number(before.nlink) !== 1 || (Number(before.mode) & 0o777) !== 0o600 || Number(before.size) > 65_536) {
    throw materializationDenied('Stage cleanup evidence changed before removal.', { path });
  }
  const final = await lstat(path);
  if (!sameFileIdentity(final, fileIdentity(before))) {
    throw materializationDenied('Stage cleanup evidence identity changed before removal.', { path });
  }
  await unlink(path);
}

async function readExactStageJson(path: string, required = true): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if (isFileError(error, 'ENOENT')) return null;
    throw materializationDenied('Exact recovery metadata cannot be opened safely.', {
      path, cause: error instanceof Error ? error.message : String(error),
    });
  });
  if (handle === null) {
    if (required) throw materializationDenied('Exact recovery metadata is missing.', { path });
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || Number(stat.uid) !== process.getuid?.() || Number(stat.nlink) !== 1
      || (Number(stat.mode) & 0o777) !== 0o600 || Number(stat.size) > 65_536) {
      throw materializationDenied('Exact recovery metadata is not a bounded owner-only regular file.', { path });
    }
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== Number(stat.size)) throw materializationDenied('Exact recovery metadata changed during read.', { path });
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
    } catch {
      throw materializationDenied('Exact recovery metadata is malformed.', { path });
    }
  } finally {
    await handle.close();
  }
}

function isMatchingStageIntent(
  value: unknown,
  stageId: string,
  plan: MaterializationPlan,
  authorization: ResourcePathAuthorization,
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const intent = value as Record<string, unknown>;
  const parent = intent.parent as Record<string, unknown> | undefined;
  return intent.version === 2 && intent.stageId === stageId && intent.recoveryKey === plan.recoveryKey
    && intent.target === plan.targetPath
    && intent.policy === plan.policy && intent.state === 'prepared'
    && parent?.dev === authorization.parent.dev && parent.ino === authorization.parent.ino
    && parent.uid === authorization.parent.uid;
}

function isMatchingCleanupEvidence(
  value: unknown,
  stageId: string,
  plan: MaterializationPlan,
  authorization: ResourcePathAuthorization,
): value is StageCleanupEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  const parent = evidence.parent as Record<string, unknown> | undefined;
  const outcome = evidence.outcome as Record<string, unknown> | undefined;
  return evidence.version === 1 && evidence.recoveryKey === plan.recoveryKey && evidence.stageId === stageId
    && evidence.target === plan.targetPath && isFileIdentity(evidence.stage)
    && parent?.dev === authorization.parent.dev && parent.ino === authorization.parent.ino
    && parent.uid === authorization.parent.uid
    && (outcome?.state === 'absent' || (outcome?.state === 'published' && isPublishedEvidence(outcome.published)));
}

type PublishedEvidence = {
  version: 1;
  stageId: string;
  method: MaterializationResult['method'];
  target: string;
  identity: FileIdentity;
  kind: 'file' | 'directory' | 'symlink';
  digest: string;
  linkTarget?: string;
};

type PublishingEvidence = {
  version: 1;
  stageId: string;
  method: MaterializationResult['method'];
  target: string;
  payload: FileIdentity;
  kind: 'file' | 'directory' | 'symlink';
  digest: string;
  linkTarget?: string;
};

type StageCleanupEvidence = {
  version: 1;
  recoveryKey: string;
  stageId: string;
  target: string;
  parent: ResourcePathAuthorization['parent'];
  stage: FileIdentity;
  outcome: { state: 'absent' } | { state: 'published'; published: PublishedEvidence };
};

function isPublishedEvidence(value: unknown): value is PublishedEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return evidence.version === 1 && typeof evidence.stageId === 'string' && typeof evidence.target === 'string'
    && isMaterializationMethod(evidence.method) && typeof evidence.identity === 'object' && evidence.identity !== null
    && typeof evidence.digest === 'string'
    && (evidence.kind === 'file' || evidence.kind === 'directory' || evidence.kind === 'symlink');
}

function isPublishingEvidence(value: unknown): value is PublishingEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return evidence.version === 1 && typeof evidence.stageId === 'string' && typeof evidence.target === 'string'
    && isMaterializationMethod(evidence.method) && typeof evidence.payload === 'object' && evidence.payload !== null
    && typeof evidence.digest === 'string'
    && (evidence.kind === 'file' || evidence.kind === 'directory' || evidence.kind === 'symlink');
}

function isFileIdentity(value: unknown): value is FileIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  return ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeMs', 'ctimeMs']
    .every((key) => typeof identity[key] === 'number' && Number.isFinite(identity[key]));
}

async function targetMatchesPublished(
  target: Awaited<ReturnType<typeof lstat>>,
  targetPath: string,
  evidence: PublishedEvidence,
  limits: { maxEntries: number; maxDepth: number },
): Promise<boolean> {
  if (evidence.target !== targetPath || target.uid !== evidence.identity.uid
    || target.dev !== evidence.identity.dev || target.ino !== evidence.identity.ino) return false;
  const typeMatches = evidence.kind === 'symlink' ? target.isSymbolicLink()
    : evidence.kind === 'file' ? target.isFile() && !target.isSymbolicLink()
      : target.isDirectory() && !target.isSymbolicLink();
  if (!typeMatches) return false;
  if (evidence.kind === 'symlink'
    && !await readlink(targetPath).then((value) => value === evidence.linkTarget).catch(() => false)) return false;
  return await digestMaterializedPath(targetPath, limits).then((digest) => digest === evidence.digest).catch(() => false);
}

async function assertPublishedTargetMatchesPayload(
  payload: Awaited<ReturnType<typeof lstat>>,
  publicationIdentity: Awaited<ReturnType<typeof lstat>>,
  published: Awaited<ReturnType<typeof lstat>>,
  payloadPath: string,
  targetPath: string,
  payloadDigest: string,
  symlinkSource: string | undefined,
  limits: { maxEntries: number; maxDepth: number },
): Promise<void> {
  if (!sameFileIdentity(published, fileIdentity(publicationIdentity))) {
    throw materializationDenied('The published target identity changed before final evidence.', { targetPath });
  }
  if (payload.isFile()) {
    const staged = await lstatIfExists(payloadPath);
    if (staged === null || !staged.isFile() || staged.isSymbolicLink()
      || staged.dev !== payload.dev || staged.ino !== payload.ino
      || published.dev !== payload.dev || published.ino !== payload.ino
      || staged.nlink !== 2 || published.nlink !== 2) {
      throw materializationDenied('The published file is no longer the exact staged hardlink.', { targetPath });
    }
  } else if (payload.isDirectory()) {
    if (await lstatIfExists(payloadPath) !== null || !published.isDirectory()
      || published.dev !== payload.dev || published.ino !== payload.ino) {
      throw materializationDenied('The published directory is no longer the exact renamed staged tree.', { targetPath });
    }
  } else if (payload.isSymbolicLink()) {
    const staged = await lstatIfExists(payloadPath);
    if (symlinkSource === undefined || staged === null || !staged.isSymbolicLink() || !published.isSymbolicLink()
      || await readlink(payloadPath) !== symlinkSource || await readlink(targetPath) !== symlinkSource) {
      throw materializationDenied('The published symlink no longer matches its verified staged link.', { targetPath });
    }
  } else {
    throw materializationDenied('The staged publication payload type changed.', { payloadPath });
  }
  const digest = await digestMaterializedPath(targetPath, limits);
  const final = await lstat(targetPath);
  if (digest !== payloadDigest || !sameFileIdentity(final, fileIdentity(published))) {
    throw materializationDenied('The published target content changed before final evidence.', { targetPath });
  }
}

async function completePublishingRecovery(
  plan: MaterializationPlan,
  stagePath: string,
  target: Awaited<ReturnType<typeof lstat>>,
  evidence: PublishingEvidence,
  limits: { maxEntries: number; maxDepth: number },
  hooks?: MaterializationHooks,
): Promise<PublishedEvidence> {
  if (evidence.target !== plan.targetPath || evidence.method === 'not-owned') {
    throw materializationDenied('Publishing recovery evidence does not match its plan.', { stagePath });
  }
  const payloadPath = join(stagePath, 'payload');
  const payload = await lstatIfExists(payloadPath);
  const targetTypeMatches = evidence.kind === 'file' ? target.isFile() && !target.isSymbolicLink()
    : evidence.kind === 'directory' ? target.isDirectory() && !target.isSymbolicLink()
      : target.isSymbolicLink();
  if (!targetTypeMatches || await digestMaterializedPath(plan.targetPath, limits) !== evidence.digest) {
    throw materializationDenied('Publishing recovery target content or type changed.', { targetPath: plan.targetPath });
  }
  if (evidence.kind === 'file') {
    if (payload === null || !payload.isFile() || payload.isSymbolicLink()
      || !sameBasicIdentity(payload, evidence.payload) || !sameBasicIdentity(target, evidence.payload)
      || payload.dev !== target.dev || payload.ino !== target.ino || payload.nlink !== 2 || target.nlink !== 2) {
      throw materializationDenied('Publishing recovery file topology is not the exact staged hardlink.', { stagePath });
    }
  } else if (evidence.kind === 'directory') {
    if (payload !== null || target.dev !== evidence.payload.dev || target.ino !== evidence.payload.ino
      || target.uid !== evidence.payload.uid) {
      throw materializationDenied('Publishing recovery directory is not the exact renamed payload.', { stagePath });
    }
  } else {
    if (payload === null || !payload.isSymbolicLink() || !sameBasicIdentity(payload, evidence.payload)
      || await readlink(payloadPath) !== evidence.linkTarget || await readlink(plan.targetPath) !== evidence.linkTarget) {
      throw materializationDenied('Publishing recovery symlink evidence changed.', { stagePath });
    }
  }
  const finalTarget = await lstat(plan.targetPath);
  const finalDigest = await digestMaterializedPath(plan.targetPath, limits);
  const finalTargetAfterDigest = await lstat(plan.targetPath);
  if (!sameFileIdentity(finalTarget, fileIdentity(target))
    || !sameFileIdentity(finalTargetAfterDigest, fileIdentity(finalTarget)) || finalDigest !== evidence.digest) {
    throw materializationDenied('Publishing recovery target changed during validation.', { targetPath: plan.targetPath });
  }
  const published: PublishedEvidence = {
    version: 1,
    stageId: evidence.stageId,
    method: evidence.method,
    target: evidence.target,
    identity: fileIdentity(finalTargetAfterDigest),
    kind: evidence.kind,
    digest: evidence.digest,
    ...(evidence.linkTarget === undefined ? {} : { linkTarget: evidence.linkTarget }),
  };
  await writeExclusiveFile(join(stagePath, 'published.json'), JSON.stringify(published), 0o600);
  await syncDirectory(stagePath);
  await hooks?.afterRecoveryEvidence?.(plan);
  return published;
}

function isMaterializationMethod(value: unknown): value is PublishedEvidence['method'] {
  return value === 'directory' || value === 'generated' || value === 'copy' || value === 'clone'
    || value === 'copy-fallback' || value === 'symlink';
}

const nodeCloneCapability: CloneFileCapability = {
  async cloneFile(sourcePath, targetPath) {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
  },
};

async function cloneOrCopy(
  plan: MaterializationPlan,
  payloadPath: string,
  clone: CloneFileCapability,
  limits: { maxEntries: number; maxDepth: number },
  hooks?: MaterializationHooks,
): Promise<'clone' | 'copy-fallback'> {
  const sourcePath = plan.sourcePath as string;
  const source = await lstat(sourcePath);
  if (!source.isFile()) {
    await copySourceTree(plan, payloadPath, limits, hooks);
    return 'copy-fallback';
  }
  try {
    await clone.cloneFile(sourcePath, payloadPath);
    const cloned = await lstat(payloadPath);
    if (!cloned.isFile() || cloned.isSymbolicLink() || cloned.size !== source.size) {
      throw new ResourceMaterializationError('RESOURCE_CLONE_UNAVAILABLE', 'Clone verification failed.', { sourcePath });
    }
    await chmod(payloadPath, conservativeMode(source.mode, false));
    return 'clone';
  } catch (error) {
    if (!isUnsupportedClone(error)) {
      if (error instanceof ResourceMaterializationError) throw error;
      throw new ResourceMaterializationError('RESOURCE_CLONE_UNAVAILABLE', 'APFS clone failed closed.', {
        sourcePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const partial = await lstatIfExists(payloadPath);
    if (partial !== null) {
      if (!partial.isFile() || partial.isSymbolicLink() || partial.nlink !== 1 || partial.uid !== process.getuid?.()) {
        throw new ResourceMaterializationError('RESOURCE_CLONE_UNAVAILABLE', 'Unsupported clone left an unsafe partial result.', {
          payloadPath,
        });
      }
      await unlink(payloadPath);
    }
    await copySourceTree(plan, payloadPath, limits, hooks);
    return 'copy-fallback';
  }
}

async function copySourceTree(
  plan: MaterializationPlan,
  destination: string,
  limits: { maxEntries: number; maxDepth: number },
  hooks?: MaterializationHooks,
): Promise<void> {
  const source = plan.sourcePath as string;
  const sourceRootStat = await lstat(source);
  let entries = 0;
  const copyEntry = async (from: string, to: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || ++entries > limits.maxEntries) {
      throw materializationDenied('Resource copy traversal exceeded its configured bound.', { source });
    }
    const stat = await lstat(from);
    if (stat.dev !== sourceRootStat.dev) {
      throw materializationDenied('Resource copy traversal crossed a device boundary.', { source, path: from });
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw materializationDenied('Resource copy traversal accepts only real regular files and directories.', { path: from });
    }
    if (stat.isDirectory()) {
      await mkdir(to, { mode: conservativeMode(stat.mode, true) });
      const children = await readdir(from);
      children.sort(codeUnitCompare);
      for (const child of children) {
        if (child === '.git') throw materializationDenied('Resource copies never include Git administrative data.', { path: join(from, child) });
        await copyEntry(join(from, child), join(to, child), depth + 1);
      }
      await chmod(to, conservativeMode(stat.mode, true));
      return;
    }
    await copyRegularFile(from, to, stat.mode);
    await hooks?.duringCopy?.(from);
  };
  await copyEntry(source, destination, 0);
}

async function buildSourceManifest(
  source: string,
  limits: { maxEntries: number; maxDepth: number },
): Promise<SourceManifestEntry[]> {
  const rootStat = await lstat(source, { bigint: true });
  let entries = 0;
  const manifest: SourceManifestEntry[] = [];
  const visit = async (path: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || ++entries > limits.maxEntries) {
      throw materializationDenied('Resource manifest traversal exceeded its configured bound.', { source });
    }
    const before = await lstat(path, { bigint: true });
    if (before.dev !== rootStat.dev) {
      throw materializationDenied('Resource manifest traversal crossed a device boundary.', { source, path });
    }
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
      throw materializationDenied('Resource manifests accept only real regular files and directories.', { path });
    }
    if (before.isDirectory()) {
      const children = (await readdir(path)).sort(codeUnitCompare);
      for (const child of children) {
        if (child === '.git') throw materializationDenied('Resource manifests never include Git administrative data.', { path: join(path, child) });
        await visit(join(path, child), relativePath === '' ? child : join(relativePath, child), depth + 1);
      }
      const after = await lstat(path, { bigint: true });
      if (!sameStableFileIdentity(stableFileIdentity(after), stableFileIdentity(before))) {
        throw materializationDenied('A source directory changed during manifest construction.', { path });
      }
      manifest.push({ path: relativePath, kind: 'directory', ...stableFileIdentity(after) });
      return;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStableFileIdentity(stableFileIdentity(opened), stableFileIdentity(before))) {
        throw materializationDenied('A source file changed before manifest hashing.', { path });
      }
      const hash = await hashOpenFile(handle);
      const after = await handle.stat({ bigint: true });
      if (!sameStableFileIdentity(stableFileIdentity(after), stableFileIdentity(opened))) {
        throw materializationDenied('A source file changed during manifest hashing.', { path });
      }
      manifest.push({ path: relativePath, kind: 'file', ...stableFileIdentity(after), hash });
    } finally {
      await handle.close();
    }
  };
  await visit(source, '', 0);
  return manifest.sort((left, right) => codeUnitCompare(left.path, right.path));
}

async function openSourceSnapshot(
  source: string,
  limits: { maxEntries: number; maxDepth: number },
): Promise<OpenSourceSnapshot> {
  const entries: OpenSourceSnapshotEntry[] = [];
  const root = await lstat(source, { bigint: true });
  let count = 0;
  const visit = async (path: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || ++count > limits.maxEntries) {
      throw materializationDenied('A retained source snapshot exceeded its descriptor bound.', {
        source, maxEntries: limits.maxEntries,
      });
    }
    const before = await lstat(path, { bigint: true });
    if (before.dev !== root.dev) {
      throw materializationDenied('A retained source snapshot crossed a device boundary.', { source, path });
    }
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
      throw materializationDenied('A retained source snapshot accepts only real regular files and directories.', { path });
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let retained = false;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameStableFileIdentity(stableFileIdentity(opened), stableFileIdentity(before))) {
        throw materializationDenied('A source entry changed while its snapshot handle was opened.', { path });
      }
      if (opened.isDirectory()) {
        const children = (await readdir(path)).sort(codeUnitCompare);
        entries.push({
          path: relativePath, absolutePath: path, kind: 'directory',
          identity: stableFileIdentity(opened), children, handle,
        });
        retained = true;
        for (const child of children) {
          if (child === '.git') {
            throw materializationDenied('Retained source snapshots never include Git administrative data.', {
              path: join(path, child),
            });
          }
          await visit(join(path, child), relativePath === '' ? child : join(relativePath, child), depth + 1);
        }
      } else {
        const hash = await hashOpenFile(handle);
        const after = await handle.stat({ bigint: true });
        if (!sameStableFileIdentity(stableFileIdentity(after), stableFileIdentity(opened))) {
          throw materializationDenied('A source file changed while its snapshot was hashed.', { path });
        }
        entries.push({
          path: relativePath, absolutePath: path, kind: 'file', identity: stableFileIdentity(after), hash, handle,
        });
        retained = true;
      }
    } finally {
      if (!retained) await handle.close();
    }
  };
  try {
    await visit(source, '', 0);
    entries.sort((left, right) => codeUnitCompare(left.path, right.path));
    return { entries, manifest: entries.map(snapshotManifestEntry) };
  } catch (error) {
    await Promise.allSettled(entries.map((entry) => entry.handle.close()));
    throw error;
  }
}

async function revalidateOpenSourceSnapshot(
  snapshot: OpenSourceSnapshot,
  planned: readonly SourceManifestEntry[],
  limits: { maxEntries: number; maxDepth: number },
): Promise<void> {
  if (snapshot.entries.length > limits.maxEntries) {
    throw materializationDenied('A retained source snapshot exceeded its final traversal bound.', {});
  }
  for (const entry of snapshot.entries) {
    const before = await entry.handle.stat({ bigint: true });
    if (!sameStableFileIdentity(stableFileIdentity(before), entry.identity)) {
      throw materializationDenied('A retained source entry changed before final validation.', { path: entry.absolutePath });
    }
    if (entry.kind === 'file') {
      const hash = await hashOpenFile(entry.handle);
      const after = await entry.handle.stat({ bigint: true });
      if (!sameStableFileIdentity(stableFileIdentity(after), entry.identity) || hash !== entry.hash) {
        throw materializationDenied('A retained source file changed before publication.', { path: entry.absolutePath });
      }
    } else {
      const children = (await readdir(entry.absolutePath)).sort(codeUnitCompare);
      if (JSON.stringify(children) !== JSON.stringify(entry.children)) {
        throw materializationDenied('A retained source directory changed before publication.', { path: entry.absolutePath });
      }
    }
  }
  // Source-last quick pass: bind every retained descriptor back to its pathname
  // after all content/directory awaits, then publish without another user hook or
  // validation await. The owner-only stage/parent is the residual same-UID boundary.
  for (const entry of snapshot.entries) {
    const descriptor = await entry.handle.stat({ bigint: true });
    const pathname = await lstat(entry.absolutePath, { bigint: true }).catch(() => null);
    if (pathname === null || !sameStableFileIdentity(stableFileIdentity(descriptor), entry.identity)
      || !sameStableFileIdentity(stableFileIdentity(pathname), entry.identity)) {
      throw materializationDenied('A retained source entry identity changed at the publication boundary.', {
        path: entry.absolutePath,
      });
    }
  }
  if (!sameSourceManifest(snapshot.manifest, planned)) {
    throw materializationDenied('The retained source snapshot does not match its plan.', {});
  }
}

async function closeOpenSourceSnapshot(snapshot: OpenSourceSnapshot): Promise<void> {
  await Promise.allSettled(snapshot.entries.map((entry) => entry.handle.close()));
}

function snapshotManifestEntry(entry: OpenSourceSnapshotEntry): SourceManifestEntry {
  return { path: entry.path, kind: entry.kind, ...entry.identity, ...(entry.hash === undefined ? {} : { hash: entry.hash }) };
}

function sameSourceManifest(left: readonly SourceManifestEntry[], right: readonly SourceManifestEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertCopiedStageManifest(
  plan: MaterializationPlan,
  payloadPath: string,
  limits: { maxEntries: number; maxDepth: number },
): Promise<void> {
  const staged = await buildSourceManifest(payloadPath, limits);
  const expected = plan.sourceManifest as readonly SourceManifestEntry[];
  if (staged.length !== expected.length) {
    throw materializationDenied('The staged copy does not match its planned source manifest.', { payloadPath });
  }
  for (let index = 0; index < expected.length; index += 1) {
    const source = expected[index] as SourceManifestEntry;
    const copy = staged[index] as SourceManifestEntry;
    if (
      source.path !== copy.path || source.kind !== copy.kind
      || Number(BigInt(copy.mode) & 0o777n) !== conservativeMode(Number(BigInt(source.mode)), source.kind === 'directory')
      || (source.kind === 'file' && (source.size !== copy.size || source.hash !== copy.hash))
    ) throw materializationDenied('The staged copy does not match its planned source manifest.', { payloadPath, path: source.path });
  }
}

async function digestMaterializedPath(
  path: string,
  limits: { maxEntries: number; maxDepth: number },
): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    return createHash('sha256').update('symlink\0').update(await readlink(path)).digest('hex');
  }
  const manifest = await buildSourceManifest(path, limits);
  const logical = manifest.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    mode: Number(BigInt(entry.mode) & 0o777n),
    size: entry.kind === 'file' ? entry.size : undefined,
    hash: entry.hash,
  }));
  return createHash('sha256').update(JSON.stringify(logical)).digest('hex');
}

async function hashOpenFile(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

async function copyRegularFile(source: string, target: string, mode: number): Promise<void> {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const targetHandle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    conservativeMode(mode, false),
  );
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await targetHandle.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await targetHandle.chmod(conservativeMode(mode, false));
    await targetHandle.sync();
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
  }
}

async function publishNoClobber(
  payloadPath: string,
  targetPath: string,
  payload: Awaited<ReturnType<typeof lstat>>,
  symlinkSource?: string,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  if (payload.isFile()) {
    const { link } = await import('node:fs/promises');
    try {
      await link(payloadPath, targetPath);
    } catch (error) {
      if (isFileError(error, 'EEXIST')) throw materializationDenied('A concurrent publication won.', { targetPath });
      throw error;
    }
    const published = await lstat(targetPath);
    if (published.dev !== payload.dev || published.ino !== payload.ino) {
      throw materializationDenied('Atomic file publication identity verification failed.', { targetPath });
    }
    return published;
  }
  if (payload.isSymbolicLink()) {
    if (symlinkSource === undefined) {
      throw materializationDenied('Immutable symlink publication requires a verified source.', { targetPath });
    }
    try {
      await symlink(symlinkSource, targetPath);
    } catch (error) {
      if (isFileError(error, 'EEXIST')) throw materializationDenied('A concurrent publication won.', { targetPath });
      throw error;
    }
    const published = await lstat(targetPath);
    if (!published.isSymbolicLink() || await readlink(targetPath) !== symlinkSource) {
      throw materializationDenied('Atomic symlink publication identity verification failed.', { targetPath });
    }
    return published;
  }
  if (!payload.isDirectory()) throw materializationDenied('Invalid staged payload type.', { payloadPath });

  // Directory rename makes the whole staged tree visible in one operation.
  // Public Node APIs do not expose renameat2(RENAME_NOREPLACE), so the final
  // absent check plus owner-only 0700 parent is the documented same-UID trust
  // boundary. The identity check ensures WTM never adopts a different tree.
  try {
    await rename(payloadPath, targetPath);
  } catch (error) {
    if (isFileError(error, 'EEXIST') || isFileError(error, 'ENOTEMPTY')) {
      throw materializationDenied('A concurrent publication won.', { targetPath });
    }
    throw error;
  }
  const published = await lstat(targetPath);
  if (!published.isDirectory() || published.dev !== payload.dev || published.ino !== payload.ino) {
    throw materializationDenied('Atomic directory publication identity verification failed.', { targetPath });
  }
  return published;
}

async function resolveAllowedSymlinkSource(plan: MaterializationPlan): Promise<string> {
  if (plan.sourcePath === undefined || plan.sourceIdentity === undefined || plan.allowedSourceRoots.length === 0) {
    throw materializationDenied('Immutable symlink publication is missing its planned source evidence.', {
      sourcePath: plan.sourcePath,
    });
  }
  const resolvedSource = await realpath(plan.sourcePath).catch(() => {
    throw materializationDenied('The immutable symlink source disappeared before publication.', {
      sourcePath: plan.sourcePath,
    });
  });
  const resolvedRoots = await Promise.all(plan.allowedSourceRoots.map(async (root) =>
    realpath(root).catch(() => {
      throw materializationDenied('An allowed symlink source root changed before publication.', { root });
    })));
  if (!resolvedRoots.some((root) => contains(root, resolvedSource))) {
    throw materializationDenied('The immutable symlink source escaped its allowlist before publication.', {
      sourcePath: resolvedSource,
      allowedRoots: resolvedRoots,
    });
  }
  const current = await lstat(resolvedSource).catch(() => null);
  if (current === null || !sameFileIdentity(current, plan.sourceIdentity)) {
    throw materializationDenied('The immutable symlink source identity changed before publication.', {
      sourcePath: resolvedSource,
    });
  }
  return resolvedSource;
}

async function assertSourceIdentity(plan: MaterializationPlan): Promise<void> {
  if (plan.sourcePath === undefined || plan.sourceIdentity === undefined) return;
  const current = await lstat(plan.sourcePath).catch(() => null);
  if (current === null || !sameFileIdentity(current, plan.sourceIdentity)) {
    throw materializationDenied('The materialization source changed after planning.', { sourcePath: plan.sourcePath });
  }
}

function assertCopyableSource(path: string, stat: Awaited<ReturnType<typeof lstat>>): void {
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw materializationDenied('Materialization sources must be regular files or directories.', { path });
  }
}

async function writeExclusiveFile(path: string, contents: string | Uint8Array, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    conservativeMode(mode, false),
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwnedStageTree(
  path: string,
  expectedRoot: FileIdentity,
  maxEntries: number,
  maxDepth: number,
  hooks?: MaterializationHooks,
): Promise<void> {
  let count = 0;
  const removeEntry = async (candidate: string, depth: number): Promise<void> => {
    if (depth > maxDepth || ++count > maxEntries) throw materializationDenied('Stage cleanup exceeded its traversal bound.', { path });
    const stat = await lstat(candidate);
    if (stat.uid !== process.getuid?.()) throw materializationDenied('Stage cleanup encountered an unowned entry.', { candidate });
    if (stat.isSymbolicLink() || stat.isFile()) {
      await hooks?.duringStageCleanup?.(path, relative(path, candidate));
      const final = await lstat(candidate);
      if (!sameFileIdentity(final, fileIdentity(stat))) {
        throw materializationDenied('Stage cleanup entry identity changed before unlink.', { candidate });
      }
      await unlink(candidate);
      return;
    }
    if (!stat.isDirectory()) throw materializationDenied('Stage cleanup encountered a special file.', { candidate });
    for (const child of (await readdir(candidate)).sort(codeUnitCompare)) await removeEntry(join(candidate, child), depth + 1);
    await hooks?.duringStageCleanup?.(path, relative(path, candidate));
    if (candidate === path) await hooks?.beforeStageCleanupRmdir?.(path);
    const final = await lstat(candidate);
    const expected = candidate === path ? expectedRoot : fileIdentity(stat);
    if (!final.isDirectory() || final.isSymbolicLink() || !sameNodeIdentity(final, expected)
      || (await readdir(candidate)).length !== 0) {
      throw materializationDenied('Stage cleanup directory identity changed before rmdir.', { candidate });
    }
    await rmdir(candidate);
  };
  await removeEntry(path, 0);
}

function conservativeMode(mode: number, directory: boolean): number {
  if (directory) return 0o700;
  const ownerBits = mode & 0o700;
  return ownerBits === 0 ? 0o600 : ownerBits;
}

function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    dev: Number(stat.dev), ino: Number(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode),
    size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs),
  };
}

function sameFileIdentity(stat: Awaited<ReturnType<typeof lstat>>, expected: FileIdentity): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.uid === expected.uid
    && stat.mode === expected.mode && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
}

function sameBasicIdentity(stat: Awaited<ReturnType<typeof lstat>>, expected: FileIdentity): boolean {
  return Number(stat.dev) === expected.dev && Number(stat.ino) === expected.ino
    && Number(stat.uid) === expected.uid && Number(stat.mode) === expected.mode
    && Number(stat.size) === expected.size;
}

function sameNodeIdentity(stat: Awaited<ReturnType<typeof lstat>>, expected: FileIdentity): boolean {
  return Number(stat.dev) === expected.dev && Number(stat.ino) === expected.ino
    && Number(stat.uid) === expected.uid && Number(stat.mode) === expected.mode;
}

function stableFileIdentity(stat: BigIntStats): StableFileIdentity {
  return {
    dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(), mode: stat.mode.toString(),
    size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    nlink: stat.nlink.toString(),
  };
}

function sameStableFileIdentity(left: StableFileIdentity, right: StableFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

function materializationRecoveryKey(plan: {
  version: number;
  policy: MaterializationRequest['policy'];
  targetPath: string;
  sourcePath?: string;
  contents?: string | Uint8Array;
  mode?: number;
  immutable: boolean;
  ownership: 'wtm' | 'external';
  allowedSourceRoots: readonly string[];
}): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    version: plan.version,
    policy: plan.policy,
    targetPath: plan.targetPath,
    sourcePath: plan.sourcePath,
    mode: plan.mode,
    immutable: plan.immutable,
    ownership: plan.ownership,
    allowedSourceRoots: plan.allowedSourceRoots,
  }));
  if (plan.contents !== undefined) {
    hash.update('\0contents\0');
    hash.update(typeof plan.contents === 'string' ? plan.contents : plan.contents);
  }
  return hash.digest('hex').slice(0, 24);
}

function isUnsupportedClone(error: unknown): boolean {
  return isFileError(error, 'ENOTSUP') || isFileError(error, 'EOPNOTSUPP')
    || isFileError(error, 'ENOSYS') || isFileError(error, 'EXDEV');
}

function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((error) => {
    if (isFileError(error, 'ENOENT')) return null;
    throw error;
  });
}

function contains(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !nested.startsWith(sep));
}

function assertAbsoluteResolved(path: string, field: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[$*?{}]/.test(path)) {
    throw materializationDenied('Materialization paths must be resolved absolute paths.', { field, path });
  }
}

function materializationDenied(message: string, context: Record<string, unknown>): ResourceMaterializationError {
  return new ResourceMaterializationError('RESOURCE_PATH_DENIED', message, context);
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isExternallyOwnedPolicy(policy: MaterializationRequest['policy']): boolean {
  return policy === 'shared' || policy === 'native-cache' || policy === 'external' || policy === 'ignore';
}
