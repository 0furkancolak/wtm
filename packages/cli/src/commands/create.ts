import { existsSync } from 'node:fs';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';
import {
  branchExists,
  createWorktree,
  GitCommandError,
  listGitWorktrees,
  planWorktreeCreation,
  SQLiteStateStore,
} from '@wtm/core';
import type { GitWorktreeRecord } from '@wtm/core';
import { DaemonRegistrationError, findRegistration } from '@wtm/daemon';
import type { RuntimeDaemonClient } from './runtime-client';

export interface CreateCommandInput {
  cwd: string;
  branch: string;
  from?: string | undefined;
  databasePath: string;
  client?: RuntimeDaemonClient | undefined;
}

/** Which of the two paths registered the new worktree, and therefore whether the hooks ran. */
export type CreateRegistration = 'daemon' | 'local';

export interface CreateCommandData {
  worktree: { path: string; branch: string | null; head: string | null };
  branch: { name: string; created: boolean; startPoint: string | null };
  /**
   * `daemon` when a running daemon reconciled and dispatched `worktree.created`; `local` when
   * the CLI registered the worktree itself, which no event dispatcher observed.
   */
  registration: CreateRegistration;
}

/**
 * Creates one linked worktree, and hands its registration to whoever should own it.
 *
 * Every refusal is decided before Git writes, so a rejected create leaves no directory, no
 * branch and no registry row. Creation itself is one `git worktree add`: there is no partial
 * state for a single repository, which is why this command takes no lease and offers no
 * `--resume`.
 */
export async function runCreateCommand(input: CreateCommandInput): Promise<JsonEnvelope<CreateCommandData | null>> {
  if (!existsSync(input.databasePath)) return failure(notInitialized());
  let store: SQLiteStateStore;
  try {
    store = new SQLiteStateStore(input.databasePath);
  } catch {
    return failure(notInitialized());
  }

  try {
    let registration;
    try {
      registration = findRegistration(store, input.cwd);
    } catch (error) {
      if (error instanceof DaemonRegistrationError) return failure(notInitialized());
      throw error;
    }
    const { workspace, repository } = registration;

    let topology: GitWorktreeRecord[];
    let exists: boolean;
    try {
      topology = await listGitWorktrees(repository.mainRoot);
      exists = await branchExists(repository.mainRoot, input.branch);
    } catch (error) {
      return failure(gitFailure(error));
    }

    const decision = planWorktreeCreation({
      workspaceRoot: workspace.root,
      mainRoot: repository.mainRoot,
      branch: input.branch,
      topology,
      branchExists: exists,
      pathExists: existsSync,
      ...(input.from === undefined ? {} : { from: input.from }),
    });
    if (decision.outcome === 'refused') return failure(decision.error);

    let created: GitWorktreeRecord;
    try {
      created = await createWorktree(repository.mainRoot, decision.plan);
    } catch (error) {
      return failure(gitFailure(error));
    }

    const warnings: WtmError[] = [];
    // The daemon flushes its reconcile queue before it answers, so a daemon that answered has
    // already registered this worktree, dispatched `worktree.created` and applied
    // `[prepare] mode`. Only when it did not does the CLI do the registration half itself.
    const registeredBy: CreateRegistration = await reconciledByDaemon(input.client) ? 'daemon' : 'local';
    if (registeredBy === 'local') {
      try {
        store.reconcileWorktrees(repository.id, await listGitWorktrees(repository.mainRoot));
      } catch (error) {
        return failure({
          code: 'GIT_REPOSITORY_DEGRADED',
          message: `The worktree was created at ${created.path} but could not be registered: `
            + `${message(error)}`,
          severity: 'error',
          context: { path: created.path, repositoryId: repository.id },
        });
      }
      // Said out loud rather than left to be discovered. Only the daemon runs the event
      // dispatcher, so with it down the worktree is registered and usable but nothing announced
      // it: an `[events."worktree.created"]` task did not start, and `[prepare] mode = "eager"`
      // did not prepare. Both happen for the *next* worktree once the daemon is back, not
      // retroactively for this one.
      warnings.push({
        code: 'WTM_DAEMON_UNAVAILABLE',
        message: 'The daemon is unreachable, so this worktree was registered locally. Its '
          + '`worktree.created` tasks did not run and `[prepare] mode = "eager"` did not '
          + 'prepare its resources; the first task you run here prepares them.',
        severity: 'warning',
        context: { path: created.path },
      });
    }

    return {
      schemaVersion: 1,
      ok: true,
      command: 'create',
      scope: { mode: 'local' },
      data: {
        worktree: { path: created.path, branch: created.branch, head: created.head },
        branch: {
          name: decision.plan.branch,
          created: decision.plan.createsBranch,
          startPoint: decision.plan.startPoint,
        },
        registration: registeredBy,
      },
      warnings,
      errors: [],
    };
  } finally {
    store.close();
  }
}

/** True only when a daemon actually answered, since that answer is what says the hooks ran. */
async function reconciledByDaemon(client: RuntimeDaemonClient | undefined): Promise<boolean> {
  if (client === undefined) return false;
  try {
    return (await client.request('reconcile')).ok === true;
  } catch {
    return false;
  }
}

function notInitialized(): WtmError {
  return {
    code: 'WTM_NOT_INITIALIZED',
    message: 'This directory is not inside a workspace WTM has registered, and only the registry '
      + 'knows the workspace root the new worktree path is computed from. Run `wtm init` first.',
    severity: 'error',
    remediation: [{ kind: 'command-suggestion', argv: ['wtm', 'init'] }],
  };
}

function gitFailure(error: unknown): WtmError {
  return {
    code: error instanceof GitCommandError ? 'GIT_COMMAND_FAILED' : 'GIT_REPOSITORY_DEGRADED',
    message: message(error),
    severity: 'error',
    ...(error instanceof GitCommandError ? { context: { command: error.argv.join(' ') } } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: WtmError): JsonEnvelope<null> {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'create',
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [error],
  };
}
