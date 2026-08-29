import { filesystemMigrationAssets, type MigrationAssetProvider } from './assets';
import { betterSqliteDatabaseFactory } from './better-sqlite-driver';
import type { SqliteDatabaseFactory } from './database';

export interface StateStoreRuntime {
  databaseFactory: SqliteDatabaseFactory;
  migrationAssets: MigrationAssetProvider;
}

let installed: StateStoreRuntime | null = null;

/**
 * Selects the storage runtime for every state store that does not receive explicit
 * options. A packaged entrypoint installs its runtime once, before any command runs.
 */
export function installStateStoreRuntime(runtime: StateStoreRuntime): void {
  if (installed !== null) throw new Error('The WTM state store runtime is already installed');
  installed = runtime;
}

export function stateStoreRuntime(): StateStoreRuntime {
  return installed ?? { databaseFactory: betterSqliteDatabaseFactory, migrationAssets: filesystemMigrationAssets };
}
