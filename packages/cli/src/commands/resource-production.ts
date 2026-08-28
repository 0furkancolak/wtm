import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  SQLiteStateStore,
  buildGcPlan,
  createResourceGuard,
  recoverGcJournalEntry,
  type GcEvidence,
  type GcJournal,
  type GcLeaseCoordinator,
  type ResourceGcEvidenceRecord,
  type ResourceSandboxIdentity,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import { runDiskCommand, type DiskCommandResult } from './disk';
import { runGcCommand, type GcCommandResult } from './gc';

export async function runProductionDiskCommand(input: {
  databasePath: string;
  cwd: string;
}): Promise<JsonEnvelope<DiskCommandResult | null>> {
  if (!existsSync(input.databasePath)) return unavailableResourceEnvelope('disk');
  const store = new SQLiteStateStore(input.databasePath, { readonly: true });
  try {
    const records = await localRecords(
      store.listResourceGcEvidence(new Date().toISOString()), store.listWorkspaces(), input.cwd,
    );
    return runDiskCommand({ sandboxes: sandboxIdentities(records), records: records.map(toGcEvidence) });
  } finally {
    store.close();
  }
}

export async function runProductionGcCommand(input: {
  databasePath: string;
  cwd: string;
  apply: boolean;
}): Promise<JsonEnvelope<GcCommandResult | null>> {
  if (!existsSync(input.databasePath)) return unavailableResourceEnvelope('gc');
  const store = new SQLiteStateStore(input.databasePath, { readonly: !input.apply });
  try {
    const now = new Date();
    const records = await localRecords(store.listResourceGcEvidence(now.toISOString()), store.listWorkspaces(), input.cwd);
    const sandboxes = sandboxIdentities(records);
    const repositories = store.listRepositories();
    const worktrees = store.listWorktrees();
    const workspaces = store.listWorkspaces();
    const items: GcCommandResult['items'] = [];
    const errors: WtmError[] = [];
    let planned = 0;
    let excluded = 0;

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
    if (errors.length > 0) {
      return {
        schemaVersion: 1,
        ok: false,
        command: 'gc',
        scope: { mode: 'local' },
        data,
        warnings: [],
        errors: errors as [WtmError, ...WtmError[]],
      };
    }
    return {
      schemaVersion: 1,
      ok: true,
      command: 'gc',
      scope: { mode: 'local' },
      data,
      warnings: [],
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

async function localRecords(
  records: readonly ResourceGcEvidenceRecord[],
  workspaces: readonly { root: string }[],
  cwd: string,
): Promise<ResourceGcEvidenceRecord[]> {
  const resolvedCwd = await realpath(cwd).catch(() => resolve(cwd));
  const workspaceRoots = await Promise.all(workspaces.map(async (item) =>
    realpath(item.root).catch(() => resolve(item.root))));
  const workspace = mostSpecificWorkspace(workspaceRoots, resolvedCwd);
  if (workspace === undefined) return [];
  const membership = await Promise.all(records.map(async (record) => {
    const sandboxRoot = await realpath(record.sandboxRoot).catch(() => resolve(record.sandboxRoot));
    return mostSpecificWorkspace(workspaceRoots, sandboxRoot) === workspace;
  }));
  return records.filter((_record, index) => membership[index] === true);
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
