/**
 * The runtime half of `wtm remove`, in production.
 *
 * Core owns the *order* a worktree is taken apart in and deliberately does not know what a
 * daemon is; this is the other side of that port, and the only place in the removal path that
 * holds both the daemon connection and the state database.
 *
 * The rule that shapes every method here is that WTM never signals a process the daemon
 * supervises from a second process. The supervisor holds the child handle, the start
 * reservation, and the identity quadruple its escalation ladder re-verifies between SIGTERM and
 * SIGKILL; a second process racing that logic would have no way to observe what it broke. So
 * stopping is a request to the daemon, and an unreachable daemon with live records is a refusal
 * rather than a best-effort kill.
 */
import {
  cleanupWorktreeEphemeralResources,
  listGitWorktrees,
  reclaimableWorktreeResourcePaths,
  type EndpointReleaseReport,
  type EphemeralCleanupReport,
  type ManagedProcessResidue,
  type ManagedProcessState,
  type RemovalRuntimeCoordinator,
  type RemovalSubject,
  type ResourceConfig,
  type SQLiteStateStore,
  type StoppedProcessesReport,
  type TemplateContext,
} from '@wtm/core';
import { featureGroup, resolveWorktreeRuntime } from '@wtm/daemon';
import { selectPlatformRuntime } from '@wtm/platform';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { Remediation, WtmError, WtmErrorCode } from '@wtm/protocol';
import type { RuntimeDaemonClient } from './commands/runtime-client';

/** The states in which a managed process record still stands between WTM and a deletion. */
const liveManagedProcessStates: readonly ManagedProcessState[] = ['STARTING', 'RUNNING', 'STOPPING'];

/**
 * The trust policy the deletion is authorized against, for a caller who did not inject one.
 *
 * `@wtm/core`'s own fallback (`defaultCoreFileTrustPolicy`) is POSIX-only by construction -- core
 * may not import `@wtm/platform` at all -- and on win32 it answers every ancestor directory
 * "group- or world-writable", because Node synthesises a Windows directory's `mode` as `0o777`
 * and `0o777 & 0o022` is never zero. So `wtm remove` refused `RESOURCE_PATH_DENIED` over the very
 * `node_modules` it had materialized, on every Windows run. The CLI is a composition root: the
 * policy has to be selected here and handed across the package boundary, exactly as
 * `runProductionGcCommand` and `runAdapterCommand` already receive one.
 *
 * Resolved on first use rather than at import, mirroring `main.ts`'s own `hostPlatformRuntime`: a
 * module-level `selectPlatformRuntime()` would make merely importing this file throw on a platform
 * WTM has no backend for, a refusal a caller could no longer catch and report as an envelope.
 */
let selectedFileTrust: FileTrustPolicy | null = null;
function hostFileTrustPolicy(): FileTrustPolicy {
  return (selectedFileTrust ??= selectPlatformRuntime().fileTrust);
}

export interface ProductionRemovalCoordinatorOptions {
  store: SQLiteStateStore;
  /** The daemon connection this invocation has, if any. */
  client?: RuntimeDaemonClient | undefined;
  /** The global configuration layer the worktree's `[resources]` table resolves against. */
  globalConfigPath: string;
  /**
   * Where a step that degraded but did not fail reports itself. These reach the command
   * envelope's `warnings`, because silence about a reconcile that did not happen is how a
   * registration ends up pointing at a directory that is gone.
   */
  warn: (warning: WtmError) => void;
  /**
   * Which file-trust policy authorizes the ephemeral-resource deletion. Defaults to the host
   * platform's own -- see `hostFileTrustPolicy` above for why core's POSIX-only fallback is the
   * wrong answer on win32.
   */
  fileTrust?: FileTrustPolicy | undefined;
  now?: (() => string) | undefined;
}

/**
 * The daemon owns processes in this worktree and cannot be reached. Refusing is the whole point:
 * the alternative is a second process signalling a group whose supervisor is not watching.
 */
export class DaemonUnavailableError extends Error {
  readonly code = 'WTM_DAEMON_UNAVAILABLE' as const;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;
  readonly remediation: readonly Remediation[];

  constructor(subject: RemovalSubject, residue: ManagedProcessResidue) {
    const owned = residue.active + residue.cleanupOwed;
    super(
      `The daemon owns ${String(owned)} running process${owned === 1 ? '' : 'es'} in this worktree and is unreachable.`,
    );
    this.name = 'DaemonUnavailableError';
    this.context = Object.freeze({
      worktreeId: subject.worktreeId,
      worktreePath: subject.worktreePath,
      active: residue.active,
      cleanupOwed: residue.cleanupOwed,
    });
    this.remediation = Object.freeze<Remediation[]>([
      { kind: 'command-suggestion', argv: ['wtm', 'daemon', 'install'] },
    ]);
  }
}

/**
 * The daemon answered the stop and reported a failure. Its own code is kept rather than
 * flattened, so `wtm remove` says the same thing about a stale identity that `wtm stop` does.
 */
export class DaemonStopFailedError extends Error {
  readonly code: WtmErrorCode;
  readonly severity = 'error' as const;
  readonly context: Record<string, unknown>;

  constructor(subject: RemovalSubject, errors: readonly WtmError[]) {
    const reported = errors[0];
    super(reported?.message ?? 'The daemon could not stop this worktree\'s managed processes.');
    this.name = 'DaemonStopFailedError';
    this.code = reported?.code ?? 'RUNTIME_STOP_FAILED';
    this.context = Object.freeze({
      ...reported?.context,
      worktreeId: subject.worktreeId,
      worktreePath: subject.worktreePath,
    });
  }
}

/**
 * A live sibling elsewhere in `subject`'s feature group, if one exists.
 *
 * `resolveWorktreeRuntime` stores a feature group's shared endpoint leases under whichever one
 * worktree in the group resolved them first (`task-resolution.ts`'s `featureGroup`), not under
 * each worktree's own row. Removing that worktree must hand its leases to a live sibling instead
 * of releasing them out from under a sibling that never changed and is still running on them.
 */
function liveFeatureGroupSibling(store: SQLiteStateStore, subject: RemovalSubject) {
  const worktree = store.listWorktrees(subject.repositoryId).find(({ id }) => id === subject.worktreeId);
  if (worktree === undefined || worktree.branch === null) return undefined;
  const repository = store.listRepositories().find(({ id }) => id === subject.repositoryId);
  const workspace = repository === undefined
    ? undefined
    : store.listWorkspaces().find(({ id }) => id === repository.workspaceId);
  if (repository === undefined || workspace === undefined) return undefined;
  return featureGroup(store, { workspace, repository, worktree })
    .find((member) => member.id !== subject.worktreeId);
}

export function createProductionRemovalCoordinator(
  options: ProductionRemovalCoordinatorOptions,
): RemovalRuntimeCoordinator {
  const now = options.now ?? (() => new Date().toISOString());
  const store = options.store;
  const fileTrust = options.fileTrust ?? hostFileTrustPolicy();

  const residueOf = (worktreeId: string): ManagedProcessResidue => {
    const records = store.listManagedProcesses({ worktreeId });
    let active = 0;
    let cleanupOwed = 0;
    for (const record of records) {
      if (liveManagedProcessStates.includes(record.state)) active += 1;
      if (record.cleanupRequired) cleanupOwed += 1;
    }
    return { active, cleanupOwed };
  };

  /**
   * The worktree's `[resources]` table, resolved the way the cleanup stage resolves it.
   *
   * Both stages read one resolution rather than two spellings of it: `reclaimablePaths` promises
   * what `cleanupEphemeralResources` will collect, and a promise the cleanup does not keep is a
   * blocker deferred past the fail-fast gate for nothing.
   */
  const resolveResources = async (
    subject: RemovalSubject,
    onFailure: (error: unknown) => void,
  ): Promise<{ worktreeRoot: string; resources: Record<string, ResourceConfig>; context: TemplateContext } | null> => {
    let runtime;
    try {
      runtime = await resolveWorktreeRuntime({
        store,
        cwd: subject.worktreePath,
        globalConfigPath: options.globalConfigPath,
        // Resolving must not take a port for a worktree that is being destroyed. Existing
        // leases are still readable, which is what a templated `{ports.api}` resource path
        // needs — and why this stage runs before the leases are released.
        allocate: false,
      });
    } catch (error) {
      onFailure(error);
      return null;
    }
    const resources = runtime.config.resources;
    if (resources === undefined) return null;
    return { worktreeRoot: runtime.registration.worktree.path, resources, context: runtime.context };
  };

  return {
    async reclaimablePaths(subject: RemovalSubject): Promise<readonly string[]> {
      // A configuration WTM cannot read is evidence of nothing, so it reports nothing: an empty
      // list defers no blocker, which leaves a worktree with a broken `wtm.toml` refusing at the
      // first gate rather than proceeding into a cleanup that cannot know what to collect. This
      // stays silent because the refusal it produces is the message; the same failure warns from
      // `cleanupEphemeralResources`, which is the stage a removal that got past the gate runs.
      const resolved = await resolveResources(subject, () => undefined);
      return resolved === null ? [] : reclaimableWorktreeResourcePaths(resolved);
    },

    async stopManagedProcesses(subject: RemovalSubject): Promise<StoppedProcessesReport> {
      const residue = residueOf(subject.worktreeId);
      // Nothing of ours is running here, so there is nothing a daemon could do about it and no
      // reason to require one. This is what keeps `wtm remove` working on a machine where the
      // daemon was never installed.
      if (residue.active === 0 && residue.cleanupOwed === 0) return { stopped: 0 };
      const client = options.client;
      if (client === undefined) throw new DaemonUnavailableError(subject, residue);
      let envelope;
      try {
        envelope = await client.request('stop', { cwd: subject.worktreePath });
      } catch {
        throw new DaemonUnavailableError(subject, residue);
      }
      if (!envelope.ok) throw new DaemonStopFailedError(subject, envelope.errors);
      return { stopped: countStoppedProcesses(envelope.data) ?? residue.active };
    },

    async verifyManagedProcessesStopped(subject: RemovalSubject): Promise<ManagedProcessResidue> {
      // Deliberately re-read rather than believe the stop response. A durable-cleanup-ownership
      // failure is exactly the case where the response looks finished and the record disagrees,
      // and the record is the thing that outlives this process.
      return residueOf(subject.worktreeId);
    },

    async cleanupEphemeralResources(subject: RemovalSubject): Promise<EphemeralCleanupReport> {
      const resolved = await resolveResources(subject, (error) => {
        // A configuration WTM cannot read is not evidence that WTM created anything, and
        // refusing here would make a worktree with a broken `wtm.toml` permanently unremovable.
        // Whatever is actually in the directory is still Git's to object to: the analysis that
        // gates the deletion runs after this stage and sees every untracked byte.
        options.warn({
          code: 'WTM_CONFIG_INVALID',
          message: `Ephemeral resource cleanup was skipped: ${message(error)}`,
          severity: 'warning',
          context: { worktreePath: subject.worktreePath },
        });
      });
      if (resolved === null) return { collected: 0, retained: [] };
      const result = await cleanupWorktreeEphemeralResources({ ...resolved, fileTrust });
      return { collected: result.collected, retained: result.retained };
    },

    async releaseEndpointLeases(subject: RemovalSubject): Promise<EndpointReleaseReport> {
      // Mark the worktree `CLEANING` before touching a single lease. `git worktree remove`
      // below is a real subprocess call with real wall-clock duration, and nothing else marks
      // this worktree dead until `reconcile` runs afterwards -- so without this, a concurrent
      // allocation on a live feature-group sibling can still see this worktree as the group's
      // "owner" for the whole of that window and attach a brand-new lease to it, which
      // `reconcileWorktrees` then silently releases once it notices Git no longer reports this
      // worktree. `featureGroup` (`@wtm/daemon`) already excludes `CLEANING` worktrees from that
      // computation; this is the one place that state was never set for a removal in progress.
      store.markWorktreeCleaning(subject.worktreeId);
      // The post-removal store step: a removed worktree's endpoint leases, its CI watches
      // (`wtm ci watch`), its task overrides (`wtm task set`) and its dev-overlay checklist
      // (`wtm checklist set`) all end here, since worktree rows are never deleted.
      store.ci.deleteForWorktree(subject.worktreeId);
      store.taskOverrides.deleteForWorktree(subject.worktreeId);
      store.checklist.deleteForWorktree(subject.worktreeId);
      // This worktree may be the one holding its whole feature group's shared endpoint leases
      // (see `liveFeatureGroupSibling`'s doc comment). Hand them to a live sibling first, so the
      // release below only ever gives back leases nothing else in the group still needs.
      const sibling = liveFeatureGroupSibling(store, subject);
      if (sibling !== undefined) store.reassignEndpointLeases(subject.worktreeId, sibling.id);
      return { released: store.releaseEndpointLeasesForWorktree(subject.worktreeId, now()) };
    },

    async reconcile(subject: RemovalSubject): Promise<void> {
      const client = options.client;
      if (client !== undefined) {
        try {
          if ((await client.request('reconcile')).ok) return;
        } catch {
          // Fall through to the local pass.
        }
      }
      // Reconciliation is bookkeeping that runs *after* Git has deleted the directory, so
      // failing here would report a removal that demonstrably happened as a failure. It warns.
      try {
        const repository = store.listRepositories().find(({ id }) => id === subject.repositoryId);
        if (repository !== undefined) {
          store.reconcileWorktrees(repository.id, await listGitWorktrees(repository.mainRoot));
        }
      } catch (error) {
        options.warn({
          code: 'GIT_REPOSITORY_DEGRADED',
          message: `The worktree was removed but the repository could not be reconciled: ${message(error)}`,
          severity: 'warning',
          context: { repositoryId: subject.repositoryId, worktreeId: subject.worktreeId },
        });
        return;
      }
      options.warn({
        code: 'WTM_DAEMON_UNAVAILABLE',
        message: 'The daemon is unreachable, so the registration was reconciled locally; '
          + 'worktree.removed will be emitted when the daemon next reconciles.',
        severity: 'warning',
        context: { repositoryId: subject.repositoryId, worktreeId: subject.worktreeId },
      });
    },
  };
}

/** How many processes the daemon says it acted on, or null when the response did not say. */
function countStoppedProcesses(data: unknown): number | null {
  if (typeof data !== 'object' || data === null || !('processes' in data)) return null;
  const processes = (data as { processes: unknown }).processes;
  return Array.isArray(processes) ? processes.length : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
