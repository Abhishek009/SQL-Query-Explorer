import * as vscode from 'vscode';
import { StoredConnection, TableEntry, TrinoColumn, TrinoQueryResult } from './types';
import { RunningQueryRegistry } from './runningQueries';
import { TrinoClient } from './engines/trino/trinoClient';
import { PostgresClient } from './engines/postgres/postgresClient';

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

export type EngineId = 'trino' | 'postgres' | 'supabase';

/** Connections without a type predate Postgres support, so they are Trino. */
export function engineOf(connection: StoredConnection): EngineId {
    return connection.type === 'postgres' || connection.type === 'supabase' ? connection.type : 'trino';
}

export const ENGINE_LABELS: Record<EngineId, string> = {
    trino: 'Trino',
    postgres: 'PostgreSQL',
    supabase: 'Supabase'
};

/** Supabase is hosted Postgres over the same wire protocol, so it addresses by
 *  database rather than catalog just like Postgres — everything but Trino does. */
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
    return addressesByDatabase(engineOf(connection))
        ? new PostgresClient(secrets, connection, registry, password)
        : new TrinoClient(secrets, connection, registry, password);
}
