import { readFileSync } from 'node:fs';

export interface MigrationAssetProvider {
  readMigrations(): readonly string[];
}

export const migrationFileNames = [
  '001-initial.sql',
  '002-managed-process-indexes.sql',
  '003-managed-process-reservations.sql',
  '004-managed-process-reservation-leases.sql',
  '005-managed-process-cleanup-ownership.sql',
  '006-resource-lifecycle.sql',
  '007-resource-gc-deleting-phase.sql',
  '008-resource-gc-container-identity.sql',
] as const;

export const filesystemMigrationAssets: MigrationAssetProvider = {
  readMigrations() {
    return migrationFileNames.map((file) => readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
  },
};
