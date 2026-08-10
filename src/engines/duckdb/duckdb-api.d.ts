/**
 * Hand-written ambient types for the slice of `@duckdb/node-api` this extension
 * actually calls. The real package is never a project dependency — installing
 * it (~100MB+ of native binaries) happens on demand at runtime, downloaded
 * into the user's machine only if they add a DuckDB connection — so there is
 * nothing on disk here for the compiler to read the real types from. Verified
 * by hand against the installed package's own .d.ts files; keep in sync if
 * DuckDB changes this API.
 */
declare module '@duckdb/node-api' {
    export class DuckDBInstance {
        static create(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
        connect(): Promise<DuckDBConnection>;
        closeSync(): void;
    }

    export class DuckDBConnection {
        run(sql: string, values?: unknown[]): Promise<DuckDBResult>;
        runAndReadAll(sql: string, values?: unknown[]): Promise<DuckDBResultReader>;
        /** Reads chunks (~2048 rows each) until at least `targetRowCount` rows are in, then stops. */
        runAndReadUntil(sql: string, targetRowCount: number, values?: unknown[]): Promise<DuckDBResultReader>;
        closeSync(): void;
    }

    export interface DuckDBResult {
        readonly rowsChanged: number;
        readonly statementType: number;
    }

    export interface DuckDBResultReader extends DuckDBResult {
        /** False once every row the query can produce has actually been read. */
        readonly done: boolean;
        columnNames(): string[];
        /** DuckDB values converted to plain JS (numbers, strings, Date, bigint, …). */
        getRowsJS(): unknown[][];
    }

    export const StatementType: {
        readonly SELECT: 1;
    };
}
