import * as vscode from 'vscode';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult } from './types';
import { RunningQueryRegistry } from './runningQueries';
import { TrinoClient } from './engines/trino/trinoClient';
import { PostgresClient } from './engines/postgres/postgresClient';
import { SqliteClient } from './engines/sqlite/sqliteClient';
import { DuckdbClient } from './engines/duckdb/duckdbClient';
import { MySqlClient } from './engines/mysql/mysqlClient';
import { MongodbClient } from './engines/mongodb/mongodbClient';
import { SnowflakeClient } from './engines/snowflake/snowflakeClient';

/**
 * What the explorer, completion, and query commands need from an engine. Every
 * engine maps its own hierarchy onto catalog → schema → table so one tree and
 * one set of commands serve all of them.
 */
export interface SqlClient {
    catalogs(token?: vscode.CancellationToken): Promise<string[]>;
    schemas(catalog: string): Promise<string[]>;
    tables(catalog: string, schema: string): Promise<string[]>;
    tableEntries(catalog: string, schema: string): Promise<TableEntry[]>;
    columns(catalog: string, schema: string, table: string): Promise<TrinoColumn[]>;
    tableDdl(catalog: string, schema: string, table: string, view?: boolean, token?: vscode.CancellationToken): Promise<string>;
    /**
     * `database` scopes the statement to one catalog/database when the editor
     * was opened against a node outside the connection's default. Postgres has
     * to honour it — a database there is a separate connection — while Trino
     * addresses catalogs inside the SQL itself and can ignore it.
     */
    query(statement: string, token?: vscode.CancellationToken, database?: string): Promise<TrinoQueryResult>;
    /** How this engine writes a table reference: Trino qualifies by catalog, Postgres cannot. */
    qualify(catalog: string | undefined, schema: string | undefined, table: string | undefined): string;
    /**
     * How this engine quotes a single identifier — double quotes for every SQL
     * engine here except MySQL/MariaDB, which use backticks; MongoDB has no SQL
     * identifiers to quote at all, so it returns the name unchanged. Callers that
     * build their own SQL text (import's column list, since it isn't a plain
     * table reference `qualify()` already covers) need this to not hardcode one
     * convention for every engine.
     */
    quoteIdentifier(identifier: string): string;
    /** A statement that works as the starting point for a blank query editor. */
    starterSql(): string;
    /**
     * A bounded "preview this table" read. Its own method rather than a plain
     * `query()` call because how a table is addressed differs by engine — Trino
     * needs `catalog.schema.table`, Postgres only ever `schema.table` since the
     * catalog there is a whole database and each one lives behind its own pool.
     */
    previewSql(catalog: string, schema: string, table: string, limit: number): string;
    previewTable(catalog: string, schema: string, table: string, limit: number, token?: vscode.CancellationToken): Promise<TrinoQueryResult>;
    maxRows(): number;
    /** Proves the connection works, returning something identifying to show back. */
    testConnection(token?: vscode.CancellationToken): Promise<string>;
}

export type EngineId = 'trino' | 'postgres' | 'supabase' | 'sqlite' | 'duckdb' | 'mysql' | 'mongodb' | 'mariadb' | 'snowflake';

const NON_TRINO_TYPES = new Set<StoredConnection['type']>(['postgres', 'supabase', 'sqlite', 'duckdb', 'mysql', 'mongodb', 'mariadb', 'snowflake']);

/** Connections without a type predate Postgres support, so they are Trino. */
export function engineOf(connection: StoredConnection): EngineId {
    return NON_TRINO_TYPES.has(connection.type) ? (connection.type as EngineId) : 'trino';
}

export const ENGINE_LABELS: Record<EngineId, string> = {
    trino: 'Trino',
    postgres: 'PostgreSQL',
    supabase: 'Supabase',
    sqlite: 'SQLite',
    duckdb: 'DuckDB',
    mysql: 'MySQL',
    mongodb: 'MongoDB',
    mariadb: 'MariaDB',
    snowflake: 'Snowflake'
};

/** MongoDB speaks shell syntax, not SQL — commands built elsewhere need to know which to generate. */
export function speaksSql(engine: EngineId): boolean {
    return engine !== 'mongodb';
}

/** Everything but Trino addresses tables via a database (a Postgres/Supabase/MySQL
 *  database, or a SQLite/DuckDB file) rather than a catalog named inside the SQL itself. */
export function addressesByDatabase(engine: EngineId): boolean {
    return engine !== 'trino';
}

export function createClient(
    secrets: vscode.SecretStorage,
    connection: StoredConnection,
    registry?: RunningQueryRegistry,
    /** Used when testing details that have not been saved to Secret Storage yet. */
    password?: string
): SqlClient {
    switch (engineOf(connection)) {
        case 'sqlite': return new SqliteClient(secrets, connection, registry, password);
        case 'duckdb': return new DuckdbClient(secrets, connection);
        case 'mysql':
        case 'mariadb': return new MySqlClient(secrets, connection, registry, password);
        case 'mongodb': return new MongodbClient(secrets, connection, registry, password);
        case 'snowflake': return new SnowflakeClient(secrets, connection, registry, password);
        case 'postgres':
        case 'supabase': return new PostgresClient(secrets, connection, registry, password);
        default: return new TrinoClient(secrets, connection, registry, password);
    }
}

/**
 * Drops any pooled connection or open file handle for a connection, for when
 * it is edited, removed, or tested with details that were never saved. Safe to
 * call for every engine at once: whichever one did not open anything is a no-op.
 */
export async function closeAllClients(connectionId?: string): Promise<void> {
    await PostgresClient.closeAll(connectionId);
    SqliteClient.closeAll(connectionId);
    DuckdbClient.closeAll(connectionId);
    await MySqlClient.closeAll(connectionId);
    await MongodbClient.closeAll(connectionId);
    await SnowflakeClient.closeAll(connectionId);
}
