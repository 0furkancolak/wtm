export interface SqliteStatement {
  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): unknown[];
}

export interface SqliteTransaction<T> {
  (): T;
  immediate(): T;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(sql: string): void;
  transaction<T>(fn: () => T): SqliteTransaction<T>;
  close(): void;
}

export type SqliteDatabaseFactory = (
  path: string,
  options: { readonly: boolean },
) => SqliteDatabase;
