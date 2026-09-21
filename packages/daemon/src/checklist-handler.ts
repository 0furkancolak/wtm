import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { containsPath, type ChecklistItemRecord, type ChecklistStore, type StateRegistrationReader } from '@wtm/core';
import {
  checklistArgumentSchemas, checklistCommandNames,
  type ChecklistItemWire, type IpcRequest, type JsonEnvelope, type WtmError,
} from '@wtm/protocol';

export interface ChecklistHandlerOptions {
  store: ChecklistStore;
  registration: Pick<StateRegistrationReader, 'listWorktrees'>;
}

export function publicChecklistItem(record: ChecklistItemRecord): ChecklistItemWire {
  return { position: record.position, text: record.text, checked: record.checked, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

/** Same tolerance `task-overrides-handler.ts`'s own copy gives a symlinked worktree path — this repo
 * tolerates near-duplicate copies of this exact helper rather than a premature shared abstraction. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Handles `checklist.list`/`checklist.set`/`checklist.clear` over the daemon's socket — the
 * agent/CLI-facing half of the dev-overlay checklist (todo item 46b, W11-1). The browser-facing
 * toggle (`checklist.setChecked`) never reaches this handler: it comes in over the proxy's own
 * HTTP listener instead, since the browser can never reach the Unix socket. See
 * `packages/daemon/src/dev-overlay.ts`'s `checklistApiHandler` for that half.
 */
export class ChecklistHandler {
  readonly #options: ChecklistHandlerOptions;

  constructor(options: ChecklistHandlerOptions) {
    this.#options = options;
  }

  async handle(request: IpcRequest): Promise<JsonEnvelope<unknown>> {
    const command = request.command;
    if (!checklistCommandNames.has(command)) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'Unknown checklist command.', severity: 'error' });
    }
    const schema = checklistArgumentSchemas[command as keyof typeof checklistArgumentSchemas];
    const parsed = schema.safeParse(request.arguments);
    if (!parsed.success) {
      return failure(command, { code: 'WTM_DAEMON_INVALID_REQUEST', message: 'Checklist arguments are invalid.', severity: 'error' });
    }
    const args = parsed.data as { cwd: string; items?: string[] };
    const worktree = this.#worktree(args.cwd);
    if (worktree === null) {
      return failure(command, {
        code: 'WTM_WORKSPACE_NOT_FOUND', message: 'This directory is not inside a worktree registered with WTM.',
        severity: 'error', context: { cwd: args.cwd },
      });
    }

    if (command === 'checklist.list') {
      return success(command, { items: this.#options.store.list(worktree.id).map(publicChecklistItem) });
    }
    if (command === 'checklist.clear') {
      return success(command, { removed: this.#options.store.clear(worktree.id) });
    }

    // command === 'checklist.set'
    const items = this.#options.store.set(worktree.id, args.items!, new Date().toISOString());
    return success(command, { items: items.map(publicChecklistItem) });
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
