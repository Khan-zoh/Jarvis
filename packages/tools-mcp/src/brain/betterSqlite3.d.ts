/**
 * Minimal ambient typing for better-sqlite3 (the package ships no types and
 * @types/better-sqlite3 is not a workspace dependency). Only the surface BrainStore
 * uses is declared.
 */
declare module 'better-sqlite3' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  type Transaction<F extends (...args: never[]) => unknown> = F & {
    default: F;
    deferred: F;
    immediate: F;
    exclusive: F;
  };

  class Database {
    constructor(filename: string, options?: { readonly?: boolean; timeout?: number });
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(pragma: string, options?: { simple?: boolean }): unknown;
    transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
    close(): this;
  }

  export = Database;
}
