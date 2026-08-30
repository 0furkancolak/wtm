import { lstat } from 'node:fs/promises';
import {
  containsPath,
  type RepositoryRecord,
  type StateRegistrationReader,
  type StateRegistrationWriter,
  type WorkspaceRecord,
} from '@wtm/core';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';

export interface ForgetCommandInput {
  store: StateRegistrationReader & StateRegistrationWriter;
  cwd: string;
  /**
   * What to retire, by workspace id, workspace name, or path. A path that is exactly a
   * registered repository root retires that repository; anything else retires the workspace
   * containing it. Defaults to the workspace containing `cwd`.
   */
  selector?: string;
  /** Retire a registration whose directory is still on disk, which is otherwise refused. */
  force?: boolean;
}

export interface ForgetCommandResult {
  /** Which registration was retired. */
  target: 'workspace' | 'repository';
  /** The workspace itself when `target` is `workspace`, else the one it belonged to. */
  workspace: { id: string; name: string; root: string };
  /** The retired repository, or `null` when a whole workspace was retired. */
  repository: { id: string; mainRoot: string } | null;
  /** What went with it, so the report says how much was retired. */
  repositories: number;
  worktrees: number;
  /** False when the root is still on disk and `--force` said to retire it anyway. */
  rootMissing: boolean;
}

export type ForgetCommandEnvelope = JsonEnvelope<ForgetCommandResult | null>;

/**
 * Retires a registration.
 *
 * A registered root can stop existing, and until this there was nothing to be done about it:
 * the daemon skipped it on every pass and `wtm doctor` reported it forever, because the only
 * way to remove a registration was to edit the state database by hand. Registering again is
 * one `wtm init`, so this is safe in the way that matters — it deletes rows, never files.
 *
 * A repository can be retired on its own, because retiring its workspace is often not an
 * option: six finished migrations whose directories are gone sat inside a workspace whose
 * other repositories are in daily use, and the workspace-sized instrument would have taken
 * those with them.
 */
export async function runForgetCommand(input: ForgetCommandInput): Promise<ForgetCommandEnvelope> {
  const workspaces = input.store.listWorkspaces();
  const target = select(input.store, workspaces, input);
  if (target === undefined) {
    return failure(input.selector === undefined
      ? {
        code: 'WTM_WORKSPACE_NOT_FOUND',
        message: 'This directory is not inside a registered workspace, and nothing was named.',
        severity: 'error',
        context: { cwd: input.cwd },
      }
      : {
        code: 'WTM_WORKSPACE_NOT_FOUND',
        message: 'No registered workspace or repository matches that name, id, or path.',
        severity: 'error',
        context: { selector: input.selector },
      });
  }

  const { workspace, repository } = target;
  const root = repository?.mainRoot ?? workspace.root;
  const rootMissing = !await isDirectory(root);
  if (!rootMissing && input.force !== true) {
    const subject = repository === undefined ? 'a workspace' : 'a repository';
    return failure({
      code: 'WTM_CONFIG_INVALID',
      message: `${root} is still on disk. Retiring ${subject} that exists loses its endpoint `
        + 'leases and process records; pass --force if that is what you mean.',
      severity: 'error',
      context: { workspace: workspace.name, root },
      remediation: [{
        kind: 'command-suggestion',
        argv: ['wtm', 'forget', repository === undefined ? workspace.name : root, '--force'],
      }],
    });
  }

  const repositories = repository === undefined
    ? input.store.listRepositories(workspace.id)
    : [repository];
  const repositoryIds = new Set(repositories.map(({ id }) => id));
  const worktrees = input.store.listWorktrees().filter(({ repositoryId }) => repositoryIds.has(repositoryId));
  const retired = repository === undefined
    ? input.store.forgetWorkspace(workspace.id)
    : input.store.forgetRepository(repository.id);
  if (!retired) {
    return failure({
      code: 'WTM_WORKSPACE_NOT_FOUND',
      message: 'The registration was gone before it could be retired.',
      severity: 'error',
      context: { workspace: workspace.name, root },
    });
  }

  return {
    schemaVersion: 1,
    ok: true,
    command: 'forget',
    scope: { mode: 'local', workspaceId: workspace.id },
    data: {
      target: repository === undefined ? 'workspace' : 'repository',
      workspace: { id: workspace.id, name: workspace.name, root: workspace.root },
      repository: repository === undefined ? null : { id: repository.id, mainRoot: repository.mainRoot },
      repositories: repositories.length,
      worktrees: worktrees.length,
      rootMissing,
    },
    warnings: [],
    errors: [],
  };
}

interface ForgetTarget {
  workspace: WorkspaceRecord;
  /** Undefined when the whole workspace is the target. */
  repository?: RepositoryRecord;
}

function select(
  store: StateRegistrationReader,
  workspaces: readonly WorkspaceRecord[],
  input: ForgetCommandInput,
): ForgetTarget | undefined {
  if (input.selector === undefined) return containingWorkspace(workspaces, input.cwd);
  const named = workspaces.filter(({ id, name }) => id === input.selector || name === input.selector);
  if (named.length === 1) return { workspace: named[0] as WorkspaceRecord };
  if (named.length > 1) return undefined;

  const path = resolveAgainst(input.cwd, input.selector);
  const workspace = containingWorkspace(workspaces, path);
  if (workspace === undefined) return undefined;
  // A path that names a repository exactly retires that repository — but never when it is also
  // the workspace root, where retiring the repository alone would leave the workspace empty
  // and every other command answering about nothing.
  if (path === workspace.workspace.root) return workspace;
  const repository = store.listRepositories(workspace.workspace.id).find(({ mainRoot }) => mainRoot === path);
  return repository === undefined ? workspace : { workspace: workspace.workspace, repository };
}

function containingWorkspace(
  workspaces: readonly WorkspaceRecord[],
  path: string,
): ForgetTarget | undefined {
  const workspace = workspaces
    .filter((candidate) => containsPath(candidate.root, path))
    .sort((left, right) => right.root.length - left.root.length)[0];
  return workspace === undefined ? undefined : { workspace };
}

function resolveAgainst(cwd: string, selector: string): string {
  return selector.startsWith('/') ? selector : `${cwd}/${selector}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function failure(error: WtmError): ForgetCommandEnvelope {
  return {
    schemaVersion: 1,
    ok: false,
    command: 'forget',
    scope: { mode: 'local' },
    data: null,
    warnings: [],
    errors: [error],
  };
}
