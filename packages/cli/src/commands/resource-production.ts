import { existsSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  SQLiteStateStore,
  buildGcPlan,
  createResourceGuard,
  recoverGcJournalEntry,
  type GcEvidence,
  type GcJournal,
  type GcLeaseCoordinator,
  type GcRepositoryLeaseInput,
  type ProcessStartTimeReader,
  type ResourceGcEvidenceRecord,
  type ResourceSandboxIdentity,
  type WorkspaceRecord,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { inspectRuntimeResources, resolveWorktreeRuntime } from '@wtm/daemon';
import { runDiskCommand, type DiskCommandResult, type DiskUsageSummary } from './disk';
import { runGcCommand, type GcCommandResult } from './gc';

export async function runProductionDiskCommand(input: {
  databasePath: string;
  cwd: string;
  globalConfigPath?: string;
}): Promise<JsonEnvelope<DiskCommandResult | null>> {
  if (!existsSync(input.databasePath)) return unavailableResourceEnvelope('disk');
  const store = new SQLiteStateStore(input.databasePath, { readonly: true });
  try {
    const records = await localRecords(
      store.listResourceGcEvidence(new Date().toISOString()), store.listWorkspaces(), input.cwd,
    );
    const worktree = await worktreeResourceUsage(store, input.cwd, input.globalConfigPath);
    return runDiskCommand({
      sandboxes: sandboxIdentities(records),
      records: records.map(toGcEvidence),
      worktree: worktree.summary,
    });
  } finally {
    store.close();
  }
}

/**
 * What the `[resources]` table has actually put inside this worktree, measured.
 *
 * These have no lifecycle record on purpose — a Git working tree may never be a resource
 * sandbox, because `gc` must never walk a repository — so nothing counted them, and `wtm disk`
 * reported zero for a workspace whose every worktree carried a linked `.env`. A symbolic link
 * is measured as the link it is, not as the file in the main worktree it points at, which
 * belongs to that worktree and would otherwise be counted once per branch.
 */
async function worktreeResourceUsage(
  store: SQLiteStateStore,
  cwd: string,
  globalConfigPath?: string,
): Promise<{ summary: DiskUsageSummary; resources: Array<{ name: string; path: string }> }> {
  const empty = { summary: { objects: 0, logicalBytes: 0, allocatedBytes: 0 }, resources: [] };
  if (globalConfigPath === undefined) return empty;
  let prepared;
  try {
    prepared = await inspectRuntimeResources(await resolveWorktreeRuntime({
      store, cwd, globalConfigPath, allocate: false,
    }));
  } catch {
    // Outside a registered worktree there is nothing local to measure, and the sandbox
    // figures above are still the answer to the question that was asked.
    return empty;
  }
  const resources: Array<{ name: string; path: string }> = [];
  const summary: DiskUsageSummary = { objects: 0, logicalBytes: 0, allocatedBytes: 0 };
  for (const resource of prepared) {
    if (resource.state !== 'ready') continue;
    const usage = await measure(resource.path);
    resources.push({ name: resource.name, path: resource.path });
    summary.objects += usage.objects;
    summary.logicalBytes += usage.logicalBytes;
    summary.allocatedBytes += usage.allocatedBytes;
  }
  return { summary, resources };
}

/** Enough of a directory to size it without turning a report into a filesystem walk. */
const maximumMeasuredEntries = 20_000;

async function measure(path: string): Promise<DiskUsageSummary> {
  const total: DiskUsageSummary = { objects: 0, logicalBytes: 0, allocatedBytes: 0 };
  const pending = [path];
  while (pending.length > 0 && total.objects < maximumMeasuredEntries) {
    const current = pending.pop() as string;
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      continue;
    }
    total.objects += 1;
    total.logicalBytes += stat.size;
    total.allocatedBytes += stat.blocks * 512;
    // A symbolic link is one entry; whatever it points at is somebody else's to account for.
    if (!stat.isDirectory()) continue;
    try {
      for (const entry of await readdir(current)) pending.push(join(current, entry));
    } catch {
      // A directory that cannot be read is still one object, already counted.
    }
  }
  return total;
}

export async function runProductionGcCommand(input: {
  databasePath: string;
  cwd: string;
  apply: boolean;
  globalConfigPath?: string;
  /**
   * How the repository operation lease learns whether a colliding holder is still alive. Required
   * only in the sense that a live `--apply` run cannot serialize against `remove`/`repair` without
   * it; a dry run never reads it, since planning never takes the lease.
   */
  readProcessStartTime?: ProcessStartTimeReader;
}): Promise<JsonEnvelope<GcCommandResult | null>> {
  if (!existsSync(input.databasePath)) return unavailableResourceEnvelope('gc');
  const store = new SQLiteStateStore(input.databasePath, { readonly: !input.apply });
  try {
    const now = new Date();
    const workspaces = store.listWorkspaces();
    const records = await localRecords(store.listResourceGcEvidence(now.toISOString()), workspaces, input.cwd);
    const sandboxes = sandboxIdentities(records);
    const repositories = store.listRepositories();
    const worktrees = store.listWorktrees();
    const items: GcCommandResult['items'] = [];
    const errors: WtmError[] = [];
    let planned = 0;
    let excluded = 0;

    // A GC plan is scoped to a resource sandbox, not to a repository — `.resources` sits under
    // the workspace and today's single-repository-per-workspace world means this is usually one
    // id, but every repository the target workspace registers is named, so a future multi-repo
    // workspace is still fully covered without this changing. A workspace with none registered
    // (a bare resources cache) has nothing a `remove`/`repair` could race, so no lease is taken.
    const repositoryIds = input.apply && input.readProcessStartTime !== undefined
      ? await repositoryIdsForLocalWorkspace(store, workspaces, input.cwd)
      : [];
    const repositoryLease: GcRepositoryLeaseInput | undefined = repositoryIds.length === 0
      ? undefined
      : { store, readProcessStartTime: input.readProcessStartTime as ProcessStartTimeReader, repositoryIds };

    for (const sandbox of sandboxes) {
      const repositoryRoots = [...new Set([
        ...repositories.map((repository) => resolve(repository.mainRoot)),
        ...worktrees.map((worktree) => resolve(worktree.path)),
      ])];
      let guard;
      try {
        const workspaceRoot = chooseWorkspaceRoot(
          sandbox.root,
          workspaces.map((workspace) => workspace.root),
        );
        guard = await createResourceGuard({
          sandboxRoot: sandbox.root,
          workspaceRoot,
          repositoryRoots,
          gitDirectoryPaths: repositories.map((repository) => resolve(repository.commonGitDir)),
        });
      } catch (error) {
        return resourceFailureEnvelope('gc', error);
      }
      const lease = sqliteLeaseCoordinator(store);
      const journal = sqliteJournal(store);
      if (input.apply) {
        const recoverable = store.listResourceGcJournal().filter((entry) =>
          entry.sandboxId === sandbox.id
          && entry.sandboxGeneration === sandbox.generation
          && (entry.phase !== 'finalized' || entry.quarantineContainer !== null));
        for (const entry of recoverable) {
          if (entry.phase === 'finalized' && entry.quarantineContainer !== null
            && !await lstat(entry.quarantineContainer.path).then(() => true).catch(() => false)) continue;
          const recovered = await recoverGcJournalEntry(entry, { guard, lease, journal });
          items.push(recovered);
          if (recovered.outcome === 'failed' || recovered.outcome === 'lease-contended') {
            errors.push({
              code: recovered.error.code,
              message: recovered.error.message,
              severity: 'error',
              context: { storageObjectId: recovered.storageObjectId, path: recovered.path, phase: recovered.phase },
            });
          }
        }
      }
      const sandboxRecords = (await localRecords(
        store.listResourceGcEvidence(now.toISOString()), workspaces, input.cwd,
      )).filter((record) => record.sandboxId === sandbox.id && record.sandboxGeneration === sandbox.generation);
      const plan = buildGcPlan({
        sandbox,
        records: sandboxRecords.map(toGcEvidence),
        now: now.toISOString(),
      });
      const envelope = await runGcCommand({
        plan,
        guard,
        ...(input.apply ? {
          apply: true,
          lease,
          journal,
          ...(repositoryLease === undefined ? {} : { repositoryLease }),
        } : {}),
      });
      planned += envelope.data?.planned ?? 0;
      excluded += envelope.data?.excluded ?? 0;
      if (envelope.data !== null) items.push(...envelope.data.items);
      errors.push(...envelope.errors);
    }

    const data: GcCommandResult = {
      mode: input.apply ? 'apply' : 'dry-run',
      planned,
      excluded,
      items,
    };
    // Worktree-local resources are deliberately outside every sandbox, so they never appear in
    // a plan. Silence there reads as "there is nothing else", which is the wrong thing to
    // believe about the `.env` in each of your branches.
    const local = await worktreeResourceUsage(store, input.cwd, input.globalConfigPath);
    const one = local.resources.length === 1;
    const warnings: WtmError[] = local.resources.length === 0 ? [] : [{
      code: 'GC_ACTIVE_WORKTREE_PROTECTED',
      message: `${local.resources.length} resource${one ? '' : 's'} declared by [resources] `
        + `${one ? 'lives' : 'live'} inside this worktree `
        + `(${local.resources.map(({ name }) => name).join(', ')}) and ${one ? 'is' : 'are'} never `
        + 'collected: gc does not walk a Git working tree. Removing the worktree removes '
        + `${one ? 'it' : 'them'}.`,
      severity: 'warning',
      context: { resources: local.resources.map(({ path }) => path).join(', ') },
    }];
    if (errors.length > 0) {
      return {
        schemaVersion: 1,
        ok: false,
        command: 'gc',
        scope: { mode: 'local' },
        data,
        warnings,
        errors: errors as [WtmError, ...WtmError[]],
      };
    }
    return {
      schemaVersion: 1,
      ok: true,
      command: 'gc',
      scope: { mode: 'local' },
      data,
      warnings,
      errors: [],
    };
  } finally {
    store.close();
  }
}

function sqliteLeaseCoordinator(store: SQLiteStateStore): GcLeaseCoordinator {
  return {
    async acquire(candidate, token) {
      return store.acquireResourceCleanupLease(candidate, token);
    },
    async renew(candidate, token) {
      return store.renewResourceCleanupLease(candidate, token);
    },
    async release(storageObjectId, token, preserveReservation) {
      store.releaseResourceCleanupLease(storageObjectId, token, preserveReservation);
    },
    async finalize(entry, token) {
      return store.finalizeResourceCleanupJournal(entry, token);
    },
  };
}

function sqliteJournal(store: SQLiteStateStore): GcJournal {
  return { async record(entry) { store.recordResourceGcJournal(entry); } };
}

function sandboxIdentities(records: readonly ResourceGcEvidenceRecord[]): ResourceSandboxIdentity[] {
  const identities = new Map<string, ResourceSandboxIdentity>();
  for (const record of records) {
    const key = `${record.sandboxId}\0${record.sandboxGeneration}`;
    const identity: ResourceSandboxIdentity = {
      id: record.sandboxId,
      root: resolve(record.sandboxRoot),
      generation: record.sandboxGeneration,
      dev: record.sandboxDev,
      ino: record.sandboxIno,
      uid: record.sandboxUid,
    };
    const existing = identities.get(key);
    if (existing !== undefined && (
      existing.root !== identity.root || existing.dev !== identity.dev
      || existing.ino !== identity.ino || existing.uid !== identity.uid
    )) throw new Error('Ambiguous resource sandbox identity in lifecycle state');
    identities.set(key, identity);
  }
  return [...identities.values()].sort((left, right) =>
    left.root < right.root ? -1 : left.root > right.root ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function toGcEvidence(record: ResourceGcEvidenceRecord): GcEvidence {
  return {
    storageObjectId: record.storageObjectId,
    path: record.path,
    sandboxId: record.sandboxId,
    sandboxRoot: record.sandboxRoot,
    sandboxGeneration: record.sandboxGeneration,
    dev: record.dev,
    ino: record.ino,
    uid: record.uid,
    kind: record.kind,
    state: record.state,
    retention: record.retention,
    referenceCount: record.referenceCount,
    owned: record.owned,
    lastUsedAt: record.lastUsedAt,
    logicalBytes: record.logicalBytes,
    allocatedBytes: record.allocatedBytes,
    cleanupLeaseToken: record.cleanupLeaseToken,
  };
}

function chooseWorkspaceRoot(sandboxRoot: string, registered: readonly string[]): string {
  const candidates = registered.map((root) => resolve(root))
    .filter((root) => contains(root, sandboxRoot) && root !== resolve(sandboxRoot));
  candidates.sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
  const selected = candidates[0];
  if (selected === undefined) throw new Error('Resource sandbox is not contained by a registered workspace');
  return selected;
}

/**
 * The registered workspace that contains `cwd`, and the resolved roots of every workspace this
 * store knows — the shared groundwork `localRecords` and the repository-lease scoping below both
 * need, computed once so a caller wanting both never resolves the same paths twice.
 */
async function resolveLocalWorkspace(
  workspaces: readonly WorkspaceRecord[],
  cwd: string,
): Promise<{ id: string; root: string; workspaceRoots: readonly string[] } | undefined> {
  const resolvedCwd = await realpath(cwd).catch(() => resolve(cwd));
  const workspaceRoots = await Promise.all(workspaces.map(async (item) =>
    realpath(item.root).catch(() => resolve(item.root))));
  const matchedRoot = mostSpecificWorkspace(workspaceRoots, resolvedCwd);
  if (matchedRoot === undefined) return undefined;
  const workspace = workspaces[workspaceRoots.indexOf(matchedRoot)];
  if (workspace === undefined) return undefined;
  return { id: workspace.id, root: matchedRoot, workspaceRoots };
}

async function localRecords(
  records: readonly ResourceGcEvidenceRecord[],
  workspaces: readonly WorkspaceRecord[],
  cwd: string,
): Promise<ResourceGcEvidenceRecord[]> {
  const local = await resolveLocalWorkspace(workspaces, cwd);
  if (local === undefined) return [];
  const membership = await Promise.all(records.map(async (record) => {
    const sandboxRoot = await realpath(record.sandboxRoot).catch(() => resolve(record.sandboxRoot));
    return mostSpecificWorkspace(local.workspaceRoots, sandboxRoot) === local.root;
  }));
  return records.filter((_record, index) => membership[index] === true);
}

/**
 * The repositories a `gc --apply` on this workspace must serialize against, so that two runs (or
 * a run and a `remove`/`repair`) racing the same repository refuse rather than corrupt anything.
 * Empty when `cwd` names no registered workspace, or that workspace has no repository yet — a
 * plan with nothing registered to protect needs no lease to protect it.
 */
async function repositoryIdsForLocalWorkspace(
  store: SQLiteStateStore,
  workspaces: readonly WorkspaceRecord[],
  cwd: string,
): Promise<string[]> {
  const local = await resolveLocalWorkspace(workspaces, cwd);
  if (local === undefined) return [];
  return store.listRepositories(local.id).map((repository) => repository.id);
}

function mostSpecificWorkspace(workspaceRoots: readonly string[], candidate: string): string | undefined {
  const matches = workspaceRoots.filter((root) => contains(root, candidate))
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
  if (matches.length > 1 && matches[0]?.length === matches[1]?.length) return undefined;
  return matches[0];
}

function contains(root: string, candidate: string): boolean {
  const nested = relative(resolve(root), resolve(candidate));
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !nested.startsWith(sep));
}

function unavailableResourceEnvelope(command: 'disk' | 'gc'): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [{ code: 'WTM_NOT_INITIALIZED', message: 'Resource lifecycle state is unavailable.', severity: 'error' }],
  };
}

function resourceFailureEnvelope(command: 'gc', error: unknown): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [{
      code: 'RESOURCE_PATH_DENIED',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
    }],
  };
}
