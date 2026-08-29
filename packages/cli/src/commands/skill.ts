import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { skillAssets, type SkillAssetProvider } from '../assets';

export { canonicalSkillPathForModule } from '../assets';

export type SkillInstallScope = 'local' | 'global';

export interface SkillInstallRequest {
  name: string;
  scope: SkillInstallScope;
  content: string;
  workspaceRoot?: string;
}

export interface SkillInstaller {
  install(request: SkillInstallRequest): Promise<{ path: string }>;
}

export interface FilesystemSkillLocations {
  localAnchor: string;
  localSkills: string;
  globalAnchor: string;
  globalSkills: string;
  hooks?: FilesystemSkillInstallerHooks;
}

export interface FilesystemSkillInstallerHookContext {
  targetDirectory: string;
  targetPath: string;
  temporaryPath: string;
}

export interface FilesystemSkillInstallerHooks {
  /** Internal deterministic race-test boundary before opening the temporary path. */
  beforeTemporaryOpen?(context: FilesystemSkillInstallerHookContext): Promise<void> | void;
  /** Internal deterministic race-test boundary after exact bytes are synced. */
  afterTemporarySync?(context: FilesystemSkillInstallerHookContext): Promise<void> | void;
  /** Internal deterministic race-test boundary immediately before final publication checks. */
  beforePublication?(context: FilesystemSkillInstallerHookContext): Promise<void> | void;
}

export interface SkillInstallResult {
  scope: SkillInstallScope;
  path: string;
}

export async function readCanonicalSkill(provider: SkillAssetProvider = skillAssets()): Promise<string> {
  return provider.readCanonicalSkill();
}

export function createFilesystemSkillInstaller(locations: FilesystemSkillLocations): SkillInstaller {
  return {
    async install(request) {
      assertSafeSkillName(request.name);
      const canonical = await readCanonicalSkill();
      const canonicalBytes = Buffer.from(canonical, 'utf8');
      if (request.name !== 'wtm' || request.content !== canonical || canonicalBytes.byteLength > MAX_SKILL_BYTES) {
        throw new Error('Filesystem installation accepts only the canonical bounded WTM Agent Skill.');
      }
      const skillRoot = request.scope === 'global' ? locations.globalSkills : locations.localSkills;
      const anchor = request.scope === 'global' ? locations.globalAnchor : locations.localAnchor;
      const targetDirectory = join(skillRoot, request.name);
      const targetPath = join(targetDirectory, 'SKILL.md');
      const identities = await ensureSafeDirectoryTree(anchor, targetDirectory);
      const temporaryPath = join(targetDirectory, `.${basename(targetPath)}.${randomUUID()}.tmp`);
      const hookContext = { targetDirectory, targetPath, temporaryPath };
      const targetEvidence = await inspectTarget(targetPath);
      let temporaryHandle: FileHandle | undefined;
      let temporaryIdentity: FileIdentity | undefined;
      let published = false;
      let failure: { error: unknown } | undefined;
      try {
        await locations.hooks?.beforeTemporaryOpen?.(hookContext);
        await verifyDirectoryTree(identities);
        await verifyTarget(targetPath, targetEvidence);
        temporaryHandle = await open(
          temporaryPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        temporaryIdentity = await auditTemporary(temporaryHandle, temporaryPath, canonicalBytes, 0o600, false);
        await writeExact(temporaryHandle, canonicalBytes);
        await temporaryHandle.sync();
        await locations.hooks?.afterTemporarySync?.(hookContext);
        temporaryIdentity = await auditTemporary(temporaryHandle, temporaryPath, canonicalBytes, 0o600, true);
        await temporaryHandle.chmod(0o644);
        await temporaryHandle.sync();
        temporaryIdentity = await auditTemporary(temporaryHandle, temporaryPath, canonicalBytes, 0o644, true);
        await verifyDirectoryTree(identities);
        await verifyTarget(targetPath, targetEvidence);
        await locations.hooks?.beforePublication?.(hookContext);
        await verifyDirectoryTree(identities);
        await verifyTarget(targetPath, targetEvidence);
        temporaryIdentity = await auditTemporary(temporaryHandle, temporaryPath, canonicalBytes, 0o644, true);
        await rename(temporaryPath, targetPath);
        await auditPublished(temporaryHandle, targetPath, temporaryIdentity, canonicalBytes);
        published = true;
      } catch (error) {
        failure = { error };
      }
      try {
        await temporaryHandle?.close();
      } catch (error) {
        failure ??= { error };
      }
      if (!published && temporaryIdentity !== undefined) {
        await cleanupExactTemporary(temporaryPath, temporaryIdentity, identities);
      }
      if (failure !== undefined) throw failure.error;
      return { path: targetPath };
    },
  };
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
}

type TargetEvidence = { state: 'absent' } | { state: 'present'; identity: FileIdentity };

const MAX_SKILL_BYTES = 64 * 1024;

async function ensureSafeDirectoryTree(anchorInput: string, targetInput: string): Promise<DirectoryIdentity[]> {
  const anchor = resolve(anchorInput);
  const target = resolve(targetInput);
  const targetRelative = relative(anchor, target);
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
    throw unsafeDestination();
  }
  const identities = [await directoryIdentity(anchor)];
  let current = anchor;
  for (const component of targetRelative.split(sep).filter((value) => value.length > 0)) {
    await verifyDirectoryTree(identities);
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    identities.push(await directoryIdentity(current));
  }
  return identities;
}

async function verifyDirectoryTree(identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const expected of identities) {
    const actual = await directoryIdentity(expected.path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw unsafeDestination();
  }
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw unsafeDestination();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() || (stat.mode & 0o022) !== 0) {
    throw unsafeDestination();
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

async function inspectTarget(path: string): Promise<TargetEvidence> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return { state: 'absent' };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid() || stat.nlink !== 1
    || (stat.mode & 0o022) !== 0) throw unsafeTarget();
  return { state: 'present', identity: identityOf(stat) };
}

async function verifyTarget(path: string, evidence: TargetEvidence): Promise<void> {
  const current = await inspectTarget(path);
  if (evidence.state !== current.state) throw unsafeTarget();
  if (evidence.state === 'present' && current.state === 'present'
    && !sameIdentity(evidence.identity, current.identity)) throw unsafeTarget();
}

async function writeExact(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0) throw unsafeTemporary();
    offset += result.bytesWritten;
  }
}

async function auditTemporary(
  handle: FileHandle,
  path: string,
  expectedBytes: Buffer,
  expectedMode: number,
  expectContent: boolean,
): Promise<FileIdentity> {
  const descriptorStat = await handle.stat();
  if (!descriptorStat.isFile() || descriptorStat.uid !== currentUid() || descriptorStat.nlink !== 1
    || (descriptorStat.mode & 0o777) !== expectedMode
    || descriptorStat.size !== (expectContent ? expectedBytes.byteLength : 0)) throw unsafeTemporary();
  const pathStat = await lstat(path).catch(() => null);
  if (pathStat === null || !pathStat.isFile() || pathStat.isSymbolicLink()
    || !sameIdentity(identityOf(descriptorStat), identityOf(pathStat))) throw unsafeTemporary();
  if (expectContent) {
    const actual = Buffer.alloc(expectedBytes.byteLength);
    const { bytesRead } = await handle.read(actual, 0, actual.byteLength, 0);
    if (bytesRead !== actual.byteLength || !actual.equals(expectedBytes)) throw unsafeTemporary();
  }
  return identityOf(descriptorStat);
}

async function auditPublished(
  handle: FileHandle,
  path: string,
  identity: FileIdentity,
  expectedBytes: Buffer,
): Promise<void> {
  const descriptorStat = await handle.stat();
  const pathStat = await lstat(path).catch(() => null);
  if (pathStat === null || !pathStat.isFile() || pathStat.isSymbolicLink()
    || pathStat.uid !== currentUid() || pathStat.nlink !== 1 || (pathStat.mode & 0o777) !== 0o644
    || pathStat.size !== expectedBytes.byteLength || !sameIdentity(identity, identityOf(pathStat))
    || !sameIdentity(identityOf(descriptorStat), identityOf(pathStat))) throw unsafeTarget();
}

async function cleanupExactTemporary(
  path: string,
  identity: FileIdentity,
  directories: readonly DirectoryIdentity[],
): Promise<void> {
  try {
    await verifyDirectoryTree(directories);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== currentUid() || stat.nlink !== 1
      || !sameIdentity(identity, identityOf(stat))) return;
    await rm(path);
  } catch {
    // Preserve missing, replaced, linked, or no-longer-anchored candidates.
  }
}

function identityOf(stat: { dev: number; ino: number; uid: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Filesystem Agent Skill installation requires POSIX ownership checks.');
  return uid;
}

function assertSafeSkillName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..' || basename(name) !== name
    || name.includes('\\') || name.includes('\0')) {
    throw new Error('Agent Skill name must be one safe path segment.');
  }
}

function unsafeDestination(): Error {
  return new Error('Agent Skill destination contains an unsafe path component.');
}

function unsafeTarget(): Error {
  return new Error('Agent Skill destination is unsafe.');
}

function unsafeTemporary(): Error {
  return new Error('Agent Skill temporary file is unsafe.');
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export async function runSkillInstallCommand(input: {
  scope: SkillInstallScope;
  installer: SkillInstaller;
  workspaceRoot?: string;
}): Promise<SkillInstallResult> {
  const installed = await input.installer.install({
    name: 'wtm',
    scope: input.scope,
    content: await readCanonicalSkill(),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
  });
  return { scope: input.scope, path: installed.path };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
