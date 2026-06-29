/**
 * Minimal ambient declaration for Node's built-in `node:sqlite` (stable enough to use, but
 * not yet present in @types/node v20). We only declare the synchronous subset we rely on.
 * When @types/node is bumped to a version that ships these types, this file can be deleted.
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = unknown>(...params: unknown[]): T | undefined;
    all<T = unknown>(...params: unknown[]): T[];
  }
  export interface DatabaseSyncOptions {
    readOnly?: boolean;
    open?: boolean;
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
