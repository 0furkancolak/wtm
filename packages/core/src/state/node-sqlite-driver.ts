import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  SqliteDatabase,
  SqliteDatabaseFactory,
  SqliteStatement,
  SqliteTransaction,
} from './database';

class NodeSqliteStatement implements SqliteStatement {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const run = this.#statement.run.bind(this.#statement) as (
      ...values: readonly unknown[]
    ) => { changes: number | bigint; lastInsertRowid: number | bigint };
    const result = run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get(...params: readonly unknown[]): unknown {
    const get = this.#statement.get.bind(this.#statement) as (...values: readonly unknown[]) => unknown;
    return get(...params);
  }

  all(...params: readonly unknown[]): unknown[] {
    const all = this.#statement.all.bind(this.#statement) as (...values: readonly unknown[]) => unknown[];
    return all(...params);
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  readonly #database: DatabaseSync;
  #savepoints = 0;

  constructor(path: string, options: { readonly: boolean }) {
    this.#database = new DatabaseSync(path, { readOnly: options.readonly });
  }

  exec(sql: string): void {
    this.#database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.#database.prepare(sql));
  }

  pragma(sql: string): void {
    this.#database.exec(`PRAGMA ${sql}`);
  }

  transaction<T>(fn: () => T): SqliteTransaction<T> {
    const run = (mode: '' | ' IMMEDIATE'): T => (
      this.#database.isTransaction ? this.#runNested(fn) : this.#runOutermost(fn, mode)
    );
    return Object.assign(
      () => run(''),
      { immediate: () => run(' IMMEDIATE') },
    );
  }

  #runOutermost<T>(fn: () => T, mode: '' | ' IMMEDIATE'): T {
    this.#database.exec(`BEGIN${mode}`);
    try {
      const result = fn();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Nested wrappers join the open transaction through a savepoint, as `better-sqlite3` does. */
  #runNested<T>(fn: () => T): T {
    this.#savepoints += 1;
    const savepoint = `wtm_savepoint_${this.#savepoints}`;
    this.#database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.#database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (this.#database.isTransaction) {
        this.#database.exec(`ROLLBACK TO ${savepoint}`);
        this.#database.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.#savepoints -= 1;
    }
  }

  close(): void {
    this.#database.close();
  }
}

export const nodeSqliteDatabaseFactory: SqliteDatabaseFactory = (path, options) => (
  new NodeSqliteDatabase(path, options)
);
