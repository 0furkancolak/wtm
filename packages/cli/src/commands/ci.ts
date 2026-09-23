import { resolve } from 'node:path';
import { containsPath, readWorktreeHead, type CiWatchRecord, type WorktreeState } from '@wtm/core';
import {
  ciArgumentSchemas, ciUnwatchResultSchema, ciWatchAcceptanceSchema,
  type CiWatch, type JsonEnvelope, type WtmError,
} from '@wtm/protocol';
import { openReadonlyStore, workspaceContaining } from '../worktree-selector';
import { requestRuntimeCommand, type RuntimeDaemonClient } from './runtime-client';

/** A local copy of the daemon's `publicCiWatch` (`packages/daemon/src/ci/watcher.ts`): the CLI
 * never imports the daemon package, so the shape the store keeps is translated to the wire shape
 * here too. */
export function publicWatch(record: CiWatchRecord): CiWatch {
  return {
    watchId: record.watchId, repo: record.providerRepo, branch: record.branch, headSha: record.headSha,
    ...(record.pr === null ? {} : { pr: record.pr }),
    state: record.state, startedAt: record.startedAt, updatedAt: record.updatedAt,
    ...(record.finishedAt === null ? {} : { finishedAt: record.finishedAt }),
    runs: record.runs,
    ...(record.detail === null ? {} : { detail: record.detail }),
  };
}

/**
 * A local copy of the daemon's `#registration` worktree filter (`packages/daemon/src/ci/
 * watcher.ts`): `wtm remove` reconciles a removed worktree's row to `ORPHANED` (`reconcileWorktrees`,
 * `packages/core/src/state/sqlite-store.ts`) rather than deleting it, and its CI watch record is
 * never pruned by a single removal (only whole-repository deregistration clears `ci_watches`).
 * Without this filter, `wtm ci status` would keep matching a `cwd` still on disk from before the
 * removal (or simply the stale path argument of a script) against the dead row's still-stored
 * path and report its last, now-meaningless CI result as current -- disagreeing with `wtm ci
 * watch`/`unwatch`, which already refuse the same worktree.
 */
function isLive(state: WorktreeState): boolean {
  return state !== 'ORPHANED' && state !== 'REMOVED';
}

/** Reads HEAD locally, then hands the watch to the daemon; it never waits for CI. */
export async function runCiWatchCommand(
  input: { cwd: string; pr?: number },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  const head = await readWorktreeHead(input.cwd);
  if (head === null) {
    return failure('ci watch', {
      code: 'WTM_CI_UNAVAILABLE', message: 'This worktree has no commit to watch.', severity: 'error',
      context: { cwd: input.cwd },
    });
  }
  const args = { cwd: input.cwd, branch: head.branch, headSha: head.headSha, ...(input.pr === undefined ? {} : { pr: input.pr }) };
  if (!ciArgumentSchemas['ci.watch'].safeParse(args).success) {
    return failure('ci watch', { code: 'WTM_CONFIG_INVALID', message: 'Invalid CI watch arguments.', severity: 'error' });
  }
  const envelope = { ...(await requestRuntimeCommand('ci.watch', args, client)), command: 'ci watch' };
  if (!envelope.ok) return envelope;
  const accepted = ciWatchAcceptanceSchema.safeParse(envelope.data);
  if (!accepted.success || accepted.data.watch.headSha !== head.headSha) {
    return failure('ci watch', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid CI watch.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

export async function runCiUnwatchCommand(
  input: { cwd: string },
  client?: RuntimeDaemonClient,
): Promise<JsonEnvelope<unknown>> {
  const envelope = { ...(await requestRuntimeCommand('ci.unwatch', { cwd: input.cwd }, client)), command: 'ci unwatch' };
  if (!envelope.ok) return envelope;
  if (!ciUnwatchResultSchema.safeParse(envelope.data).success) {
    return failure('ci unwatch', { code: 'WTM_DAEMON_REQUEST_FAILED', message: 'Daemon returned an invalid CI unwatch result.', severity: 'error' }, envelope.data);
  }
  return envelope;
}

/** Local and read-only: no daemon, no network. */
export function readCiStatus(input: { cwd: string; all: boolean; databasePath: string }): JsonEnvelope<unknown> {
  const store = openReadonlyStore(input.databasePath);
  if (store === null) return success('ci status', input.all ? { watches: [] } : { watch: null });
  try {
    const current = resolve(input.cwd);
    if (input.all) {
      // Corrections while planning (8): `--all` scopes to the workspace containing `cwd` and does
      // not apply item 47's workspace-root refusal — a workspace root is exactly where an agent
      // asking for every worktree's CI would stand.
      const workspace = workspaceContaining(store, current);
      if (workspace === undefined) {
        return failure('ci status', {
          code: 'WTM_WORKSPACE_NOT_FOUND', message: 'This directory is not inside a registered workspace.', severity: 'error',
          context: { cwd: input.cwd },
        });
      }
      const repositories = new Set(store.listRepositories(workspace.id).map(({ id }) => id));
      const watches = store.listWorktrees()
        .filter(({ repositoryId, state }) => repositories.has(repositoryId) && isLive(state))
        .flatMap((worktree) => {
          const watch = safeLatest(store, worktree.id);
          return watch === null ? [] : [{ worktreePath: worktree.path, watch: publicWatch(watch) }];
        })
        .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath));
      return success('ci status', { watches });
    }
    const worktree = store.listWorktrees()
      .filter(({ path, state }) => isLive(state) && containsPath(path, current))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (worktree === undefined) {
      return failure('ci status', {
        code: 'WTM_WORKSPACE_NOT_FOUND', message: 'This directory is not inside a registered worktree.', severity: 'error',
        context: { cwd: input.cwd },
        remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'ci', 'status', '--all'] }],
      });
    }
    const watch = safeLatest(store, worktree.id);
    return success('ci status', { watch: watch === null ? null : publicWatch(watch) });
  } finally {
    store.close();
  }
}

/** A database the daemon has not migrated to the CI watch schema yet simply has no watches. */
function safeLatest(store: NonNullable<ReturnType<typeof openReadonlyStore>>, worktreeId: string): CiWatchRecord | null {
  try {
    return store.ci.latestForWorktree(worktreeId);
  } catch {
    return null;
  }
}

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

function failure(command: string, error: WtmError, data: unknown = null): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: false, command, data, warnings: [], errors: [error] };
}
