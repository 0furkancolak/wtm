import {
  AdapterTrustError,
  ensurePrivateDirectory,
  verifyPrivateDirectory,
  trustRepositoryAdapter,
  type AdapterTrustRecord,
  type AdapterTrustStore,
} from '@wtm/core';
import { basename, dirname, join } from 'node:path';
import type { JsonEnvelope, WtmError } from '@wtm/protocol';

interface AdapterCommandBase {
  databasePath: string;
  trust?: AdapterTrustStore;
  workspaceId?: string;
  /** Internal race-test boundary immediately before SQLite is opened. */
  beforeDatabaseOpen?(): Promise<void> | void;
}

export type AdapterCommandInput =
  | AdapterCommandBase & { action: 'list' }
  | AdapterCommandBase & { action: 'trust'; adapterId: string; executablePath: string };

export type AdapterCommandResult = AdapterTrustRecord | { adapters: readonly AdapterTrustRecord[] };
export type AdapterCommandEnvelope = JsonEnvelope<AdapterCommandResult | null>;

export async function runAdapterCommand(input: AdapterCommandInput): Promise<AdapterCommandEnvelope> {
  const command = `adapter ${input.action}`;
  try {
    const opened = await openTrustStore(input);
    try {
      const data: AdapterCommandResult = input.action === 'list'
        ? { adapters: opened.trust.list() }
        : await trustRepositoryAdapter(opened.trust, {
          adapterId: input.adapterId,
          executablePath: input.executablePath,
        });
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
  const parent = await ensurePrivateDirectory(dirname(input.databasePath));
  const databasePath = join(parent.path, basename(input.databasePath));
  await input.beforeDatabaseOpen?.();
  await verifyPrivateDirectory(parent);
  const { SQLiteStateStore, createSqliteAdapterTrustStore } = await import('@wtm/core');
  const state = new SQLiteStateStore(databasePath);
  try {
    await verifyPrivateDirectory(parent);
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
  return {
    code: 'ADAPTER_NOT_TRUSTED',
    message: 'External adapter trust operation failed.',
    severity: 'error',
    context: { action },
  };
}
