import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { containsPath, taskSchema, type StateRegistrationReader, type TaskOverrideRecord, type TaskOverrideStore } from '@wtm/core';
import {
  taskOverrideArgumentSchemas, taskOverrideCommandNames,
  type IpcRequest, type JsonEnvelope, type TaskOverrideRecordWire, type WtmError,
} from '@wtm/protocol';

export interface TaskOverridesHandlerOptions {
  store: TaskOverrideStore;
  registration: Pick<StateRegistrationReader, 'listWorktrees'>;
}

export function publicTaskOverride(record: TaskOverrideRecord): TaskOverrideRecordWire {
  return { taskName: record.taskName, task: record.task, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

/** Same tolerance `ci/watcher.ts`'s `#registration` gives a symlinked worktree path. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Handles `task.list`/`task.show`/`task.set`/`task.unset` over the daemon's socket. There is no
 * timer here, unlike `CiWatcher`: an override is a row a request reads or writes once, never a
 * background poll.
 */
export class TaskOverridesHandler {
  readonly #options: TaskOverridesHandlerOptions;

  constructor(options: TaskOverridesHandlerOptions) {
    this.#options = options;
  }

  async handle(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    const command = request.command;
    if (!taskOverrideCommandNames.has(command)) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'Unknown task override command.', severity: 'error' });
    }
    const schema = taskOverrideArgumentSchemas[command as keyof typeof taskOverrideArgumentSchemas];
    const parsed = schema.safeParse(request.arguments);
    if (!parsed.success) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'Task override arguments are invalid.', severity: 'error' });
    }
    const args = parsed.data as { cwd: string; taskName?: string; task?: unknown };
    const worktree = this.#worktree(args.cwd);
    if (worktree === null) {
      return failure(command, {
        code: 'WTM_WORKSPACE_NOT_FOUND', message: 'This directory is not inside a worktree registered with WTM.',
        severity: 'error', context: { cwd: args.cwd },
      });
    }

    if (command === 'task.list') {
      return success(command, { tasks: this.#options.store.listForWorktree(worktree.id).map(publicTaskOverride) });
    }
    if (command === 'task.show') {
      const record = this.#options.store.get(worktree.id, args.taskName!);
      return success(command, { task: record === null ? null : publicTaskOverride(record) });
    }
    if (command === 'task.unset') {
      return success(command, { removed: this.#options.store.unset(worktree.id, args.taskName!) });
    }

    // command === 'task.set'
    const task = taskSchema.safeParse(args.task);
    if (!task.success) {
      return failure(command, {
        code: 'WTM_CONFIG_INVALID', message: 'Invalid task definition.', severity: 'error',
        context: { issues: task.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
      });
    }
    const record = this.#options.store.set({
      worktreeId: worktree.id, taskName: args.taskName!, task: task.data, now: new Date().toISOString(),
    });
    return success(command, { task: publicTaskOverride(record) });
  }

  #worktree(cwd: string) {
    const current = canonical(resolve(cwd));
    return this.#options.registration.listWorktrees()
      .filter(({ path, state }) => state !== 'ORPHANED' && state !== 'REMOVED' && containsPath(canonical(path), current))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
  }
}

function success(command: string, data: unknown): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: true, command, data, warnings: [], errors: [] };
}

function failure(command: string, error: WtmError): JsonEnvelope<unknown> {
  return { schemaVersion: 1, ok: false, command, data: null, warnings: [], errors: [error] };
}
