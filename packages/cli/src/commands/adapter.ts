import {
  AdapterTrustError,
  PrivateDirectoryError,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  trustRepositoryAdapter,
  type AdapterTrustRecord,
  type AdapterTrustStore,
} from '@wtm/core';
import { basename, dirname, join } from 'node:path';
import type { FileTrustPolicy } from '@wtm/platform/ports';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';

interface AdapterCommandBase {
  databasePath: string;
  trust?: AdapterTrustStore;
  workspaceId?: string;
  /** Internal race-test boundary immediately before SQLite is opened. */
  beforeDatabaseOpen?(): Promise<void> | void;
  /**
   * Defaults to `ensurePrivateDirectory`/`verifyPrivateDirectory`'s own POSIX-only fallback,
   * which reports no identity at all on win32 and so refuses every call unconditionally -- the
   * caller who has already selected a real platform runtime should pass its `fileTrust` instead.
   */
  fileTrust?: FileTrustPolicy;
}

export type AdapterCommandInput =
  | AdapterCommandBase & { action: 'list' }
  | AdapterCommandBase & { action: 'trust'; adapterId: string; executablePath: string }
  | AdapterCommandBase & { action: 'untrust'; adapterId: string };

export type AdapterCommandResult =
  | AdapterTrustRecord
  | { adapters: readonly AdapterTrustRecord[] }
  | { removed: boolean };
export type AdapterCommandEnvelope = JsonEnvelope<AdapterCommandResult | null>;

export async function runAdapterCommand(input: AdapterCommandInput): Promise<AdapterCommandEnvelope> {
  const command = `adapter ${input.action}`;
  try {
    const opened = await openTrustStore(input);
    try {
      const data: AdapterCommandResult = input.action === 'list'
        ? { adapters: opened.trust.list() }
        : input.action === 'untrust'
        ? { removed: await opened.trust.untrust(input.adapterId) }
        // The selected policy has to reach the executable's own safety checks too, not just the
        // private directory above the database. `trustRepositoryAdapter` defaults to core's
        // POSIX-only fallback, which answers `currentIdentityAvailable()` false on win32 and
        // refuses every `wtm adapter trust` there before reading a byte -- the reason
        // `main.test.ts`'s CLI-level case failed on Windows while its own trust store was
        // injected and no private directory was ever involved.
        : await trustRepositoryAdapter(opened.trust, {
          adapterId: input.adapterId,
          executablePath: input.executablePath,
        }, input.fileTrust);
      return {
        schemaVersion: 1,
        ok: true,
        command,
        scope: scope(input),
        data,
        warnings: [],
        errors: [],
      };
    } finally {
      opened.close();
    }
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      command,
      scope: scope(input),
      data: null,
      warnings: [],
      errors: [toAdapterCommandError(error, input.action)],
    };
  }
}

async function openTrustStore(input: AdapterCommandBase): Promise<{
  trust: AdapterTrustStore;
  close(): void;
}> {
  if (input.trust !== undefined) return { trust: input.trust, close: () => {} };
  const parent = await ensurePrivateDirectory(dirname(input.databasePath), input.fileTrust);
  const databasePath = join(parent.path, basename(input.databasePath));
  await input.beforeDatabaseOpen?.();
  await verifyPrivateDirectory(parent, input.fileTrust);
  const { SQLiteStateStore, createSqliteAdapterTrustStore } = await import('@wtm/core');
  const state = new SQLiteStateStore(databasePath);
  try {
    await verifyPrivateDirectory(parent, input.fileTrust);
    return { trust: createSqliteAdapterTrustStore(state), close: () => state.close() };
  } catch (error) {
    state.close();
    throw error;
  }
}

function scope(input: { workspaceId?: string }): { mode: 'local'; workspaceId?: string } {
  return { mode: 'local', ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }) };
}

function toAdapterCommandError(error: unknown, action: AdapterCommandInput['action']): WtmError {
  if (error instanceof AdapterTrustError) {
    return {
      code: error.code,
      message: error.message,
      severity: error.severity,
      context: { action },
    };
  }
  // Only `WTM_PRIVATE_DIRECTORY_UNSAFE` is a registered `WtmErrorCode` -- see
  // `private-directory.ts`'s own doc comment on why `WTM_PRIVATE_DIRECTORY_UNAVAILABLE` is
  // deliberately not (it covers a lookup that may just be a slow-to-arrive volume, so it stays
  // uncoded and retried). Putting that one in the envelope would fail the contract's own strict
  // code enum, so it falls through to the same generic refusal below, same as before this branch
  // existed -- still accurate, since the trust operation did fail either way.
  if (error instanceof PrivateDirectoryError && error.code === 'WTM_PRIVATE_DIRECTORY_UNSAFE') {
    return {
      code: error.code,
      message: error.message,
      severity: error.severity,
      context: { action, ...error.context },
      ...(error.remediation.length > 0 ? { remediation: [...error.remediation] } : {}),
    };
  }
  return {
    code: 'ADAPTER_NOT_TRUSTED',
    message: 'External adapter trust operation failed.',
    severity: 'error',
    context: { action },
  };
}
