import Database from 'better-sqlite3';
import type {
  SqliteDatabase,
  SqliteDatabaseFactory,
  SqliteStatement,
  SqliteTransaction,
} from './database';

class BetterSqliteStatement implements SqliteStatement {
  readonly #statement: Database.Statement;

  constructor(statement: Database.Statement) {
    this.#statement = statement;
  }

  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.#statement.run(...params);
  }

  get(...params: readonly unknown[]): unknown {
    return this.#statement.get(...params);
  }

  all(...params: readonly unknown[]): unknown[] {
    return this.#statement.all(...params);
  }
}

class BetterSqliteDatabase implements SqliteDatabase {
  readonly #database: Database.Database;

  constructor(path: string, options: { readonly: boolean }) {
    this.#database = new Database(
      path,
      options.readonly ? { readonly: true, fileMustExist: true } : undefined,
    );
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new BetterSqliteStatement(this.#database.prepare(sql));
  }

  pragma(sql: string): void {
    this.#database.pragma(sql);
  }

  transaction<T>(fn: () => T): SqliteTransaction<T> {
    const transaction = this.#database.transaction(fn);
    return Object.assign(
      () => transaction(),
      { immediate: () => transaction.immediate() },
    );
  }

  close(): void {
    this.#database.close();
  }
}

export const betterSqliteDatabaseFactory: SqliteDatabaseFactory = (path, options) => (
  new BetterSqliteDatabase(path, options)
);
